import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getBaseCurrency, findExchangeRate } from '@/lib/currency';
import { TreasurerReportData } from '@/lib/reports/types';
import { getEffectiveStartDate } from '@/lib/date-utils';

function toNumber(num: bigint | null, denom: bigint | null): number {
    if (num === null || denom === null || denom === 0n) return 0;
    return parseFloat(toDecimal(num, denom));
}

/**
 * Pre-fetch exchange rates for a set of commodity GUIDs to the base currency.
 * Returns a Map of commodityGuid -> exchange rate number.
 * Currencies matching baseCurrencyGuid are excluded (rate is implicitly 1.0).
 */
async function prefetchExchangeRates(
    commodityGuids: string[],
    baseCurrencyGuid: string,
    asOfDate?: Date
): Promise<Map<string, number>> {
    const rateMap = new Map<string, number>();
    const uniqueGuids = [...new Set(commodityGuids.filter(g => g && g !== baseCurrencyGuid))];

    await Promise.all(
        uniqueGuids.map(async (guid) => {
            const rate = await findExchangeRate(guid, baseCurrencyGuid, asOfDate);
            if (rate) {
                rateMap.set(guid, rate.rate);
            }
        })
    );

    return rateMap;
}

/**
 * Compute the balance of asset/bank/cash accounts up to a given date,
 * converted to base currency.
 *
 * Batches all splits into a single query and pre-fetches exchange rates
 * to avoid N+1 query patterns.
 */
async function computeBalances(
    bookAccountGuids: string[],
    asOfDate: Date,
    baseCurrencyGuid: string,
    customAccountGuids?: string[] | null
): Promise<{ accounts: Array<{ name: string; balance: number }>; total: number }> {
    // If custom GUIDs provided, intersect with book scope for security
    const validGuids = customAccountGuids && customAccountGuids.length > 0
        ? customAccountGuids.filter(g => bookAccountGuids.includes(g))
        : null;

    const assetAccounts = await prisma.accounts.findMany({
        where: validGuids && validGuids.length > 0
            ? { guid: { in: validGuids }, hidden: 0, placeholder: 0 }
            : { guid: { in: bookAccountGuids }, account_type: { in: ['ASSET', 'BANK', 'CASH'] }, hidden: 0, placeholder: 0 },
        select: {
            guid: true,
            name: true,
            commodity_guid: true,
        },
    });

    if (assetAccounts.length === 0) {
        return { accounts: [], total: 0 };
    }

    const assetAccountGuids = assetAccounts.map(a => a.guid);

    // Batch: fetch ALL splits for all asset accounts in a single query
    const allSplits = await prisma.splits.findMany({
        where: {
            account_guid: { in: assetAccountGuids },
            transaction: {
                post_date: { lte: asOfDate },
            },
        },
        select: {
            account_guid: true,
            quantity_num: true,
            quantity_denom: true,
        },
    });

    // Group splits by account_guid
    const splitsByAccount = new Map<string, typeof allSplits>();
    for (const split of allSplits) {
        const existing = splitsByAccount.get(split.account_guid);
        if (existing) {
            existing.push(split);
        } else {
            splitsByAccount.set(split.account_guid, [split]);
        }
    }

    // Pre-fetch exchange rates for all distinct non-base currency GUIDs
    const commodityGuids = assetAccounts
        .map(a => a.commodity_guid)
        .filter((g): g is string => g !== null);
    const rateMap = await prefetchExchangeRates(commodityGuids, baseCurrencyGuid, asOfDate);

    const accounts: Array<{ name: string; balance: number }> = [];
    let total = 0;

    for (const account of assetAccounts) {
        const accountSplits = splitsByAccount.get(account.guid) || [];
        let balance = accountSplits.reduce((sum, s) => sum + toNumber(s.quantity_num, s.quantity_denom), 0);

        // Currency conversion if needed
        if (account.commodity_guid && account.commodity_guid !== baseCurrencyGuid) {
            const rate = rateMap.get(account.commodity_guid);
            if (rate !== undefined) {
                balance = balance * rate;
            }
        }

        if (Math.abs(balance) > 0.005) {
            accounts.push({ name: account.name, balance: Math.round(balance * 100) / 100 });
            total += balance;
        }
    }

    total = Math.round(total * 100) / 100;
    return { accounts, total };
}

/**
 * Get itemized income or expense transactions in a period.
 * For INCOME accounts, amounts are negated to show as positive.
 *
 * Pre-fetches exchange rates for all distinct non-base commodities
 * to avoid N+1 query patterns.
 */
async function getTransactionsByType(
    bookAccountGuids: string[],
    accountType: 'INCOME' | 'EXPENSE',
    startDate: Date,
    endDate: Date,
    baseCurrencyGuid: string
): Promise<{ transactions: TreasurerReportData['incomeSummary']['transactions']; total: number }> {
    const typeAccounts = await prisma.accounts.findMany({
        where: {
            guid: { in: bookAccountGuids },
            account_type: accountType,
            hidden: 0,
        },
        select: {
            guid: true,
            name: true,
            commodity_guid: true,
        },
    });

    const accountMap = new Map(typeAccounts.map(a => [a.guid, a]));
    const accountGuids = typeAccounts.map(a => a.guid);

    if (accountGuids.length === 0) {
        return { transactions: [], total: 0 };
    }

    const splits = await prisma.splits.findMany({
        where: {
            account_guid: { in: accountGuids },
            transaction: {
                post_date: {
                    gte: startDate,
                    lte: endDate,
                },
            },
        },
        include: {
            transaction: {
                select: {
                    description: true,
                    post_date: true,
                },
            },
        },
    });

    // Pre-fetch exchange rates for all distinct non-base commodity GUIDs
    const commodityGuids = typeAccounts
        .map(a => a.commodity_guid)
        .filter((g): g is string => g !== null);
    const rateMap = await prefetchExchangeRates(commodityGuids, baseCurrencyGuid, endDate);

    const transactions: TreasurerReportData['incomeSummary']['transactions'] = [];
    let total = 0;

    for (const split of splits) {
        const account = accountMap.get(split.account_guid);
        if (!account) continue;

        let amount = toNumber(split.quantity_num, split.quantity_denom);

        // Currency conversion if needed (using pre-fetched rates)
        if (account.commodity_guid && account.commodity_guid !== baseCurrencyGuid) {
            const rate = rateMap.get(account.commodity_guid);
            if (rate !== undefined) {
                amount = amount * rate;
            }
        }

        // Income amounts in GnuCash are negative (credit entries) - negate to show positive
        if (accountType === 'INCOME') {
            amount = -amount;
        }

        amount = Math.round(amount * 100) / 100;

        transactions.push({
            date: split.transaction.post_date
                ? split.transaction.post_date.toISOString().split('T')[0]
                : '',
            description: split.transaction.description || '(no description)',
            category: account.name,
            amount,
        });

        total += amount;
    }

    // Sort by date
    transactions.sort((a, b) => a.date.localeCompare(b.date));

    total = Math.round(total * 100) / 100;
    return { transactions, total };
}

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const bookAccountGuids = await getBookAccountGuids();
        const baseCurrency = await getBaseCurrency();
        const baseCurrencyGuid = baseCurrency?.guid || '';

        const startDate = await getEffectiveStartDate(searchParams.get('startDate'));
        const endDate = searchParams.get('endDate')
            ? new Date(searchParams.get('endDate')! + 'T23:59:59Z')
            : new Date();

        const accountGuidsParam = searchParams.get('accountGuids');
        const customAccountGuids = accountGuidsParam
            ? accountGuidsParam.split(',').filter(g => g.trim())
            : null;

        // Opening balance: sum of asset accounts up to (but not including) period start
        const openingCutoff = new Date(startDate.getTime() - 1);
        const openingBalance = await computeBalances(bookAccountGuids, openingCutoff, baseCurrencyGuid, customAccountGuids);

        // Closing balance: sum of asset accounts up to period end
        const closingBalance = await computeBalances(bookAccountGuids, endDate, baseCurrencyGuid, customAccountGuids);

        // Income transactions in period
        const incomeSummary = await getTransactionsByType(
            bookAccountGuids, 'INCOME', startDate, endDate, baseCurrencyGuid
        );

        // Expense transactions in period
        const expenseSummary = await getTransactionsByType(
            bookAccountGuids, 'EXPENSE', startDate, endDate, baseCurrencyGuid
        );

        const data: TreasurerReportData = {
            header: {
                organization: '',
                roleName: '',
                personName: '',
                reportDate: new Date().toISOString().split('T')[0],
                periodStart: startDate.toISOString().split('T')[0],
                periodEnd: endDate.toISOString().split('T')[0],
            },
            openingBalance,
            incomeSummary,
            expenseSummary,
            closingBalance,
        };

        return NextResponse.json(data);
    } catch (error) {
        console.error('Error generating treasurer report:', error);
        return NextResponse.json(
            { error: 'Failed to generate treasurer report' },
            { status: 500 }
        );
    }
}
