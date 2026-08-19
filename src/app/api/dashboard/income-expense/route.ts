import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { sumSplitsByAccountAndMonth } from '@/lib/reports/utils';
import { buildMonthlySeries } from '@/lib/dashboard/income-expense-series';
import { getBookAccountGuids, getActiveBookGuid } from '@/lib/book-scope';
import { getEffectiveStartDate } from '@/lib/date-utils';
import { getBaseCurrency, findExchangeRate } from '@/lib/currency';
import { cacheGet, cacheSet } from '@/lib/cache';
import { requireRole } from '@/lib/auth';

/**
 * Build a full path for an account by traversing its parent chain.
 * Uses a pre-fetched account map for efficiency.
 */
function buildAccountPath(
    accountGuid: string,
    accountMap: Map<string, { name: string; parent_guid: string | null }>
): string {
    const segments: string[] = [];
    let currentGuid: string | null = accountGuid;

    while (currentGuid) {
        const acc = accountMap.get(currentGuid);
        if (!acc) break;
        segments.unshift(acc.name);
        currentGuid = acc.parent_guid;
    }

    return segments.join(':');
}

/**
 * Check if an account path contains "Tax" (case-insensitive) in any segment.
 */
// buildAccountPath() traverses the full parent chain via parent_guid,
// so the path includes all ancestor names (e.g. "Root:Expenses:Taxes:Federal").
// This means the "tax" check correctly matches at any level of the hierarchy.
function isTaxAccount(path: string): boolean {
    return path.toLowerCase().includes('tax');
}

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const searchParams = request.nextUrl.searchParams;
        const startDateParam = searchParams.get('startDate');
        const endDateParam = searchParams.get('endDate');

        const now = new Date();
        const endDate = endDateParam ? new Date(endDateParam + 'T23:59:59Z') : now;

        // Get book account GUIDs for scoping (needed for effective start date)
        const bookAccountGuids = await getBookAccountGuids();
        const startDate = await getEffectiveStartDate(startDateParam, bookAccountGuids);

        // Build cache key from book guid + metric + date params
        const bookGuid = await getActiveBookGuid();
        const cacheKey = `cache:${bookGuid}:income-expense:${startDate.toISOString().split('T')[0]}-${endDate.toISOString().split('T')[0]}`;

        // Check cache first
        const cached = await cacheGet(cacheKey);
        if (cached) {
            return NextResponse.json(cached);
        }

        // Fetch all accounts in active book for path building
        const allAccounts = await prisma.accounts.findMany({
            where: {
                guid: { in: bookAccountGuids },
            },
            select: {
                guid: true,
                name: true,
                account_type: true,
                parent_guid: true,
                hidden: true,
                commodity_guid: true,
            },
        });

        const accountMap = new Map(
            allAccounts.map(a => [a.guid, { name: a.name, parent_guid: a.parent_guid }])
        );

        // Get non-hidden INCOME and EXPENSE accounts
        const relevantAccounts = allAccounts.filter(
            a => (a.account_type === 'INCOME' || a.account_type === 'EXPENSE') && a.hidden === 0
        );

        const incomeGuids = new Set(
            relevantAccounts.filter(a => a.account_type === 'INCOME').map(a => a.guid)
        );
        const expenseGuids = new Set(
            relevantAccounts.filter(a => a.account_type === 'EXPENSE').map(a => a.guid)
        );

        // Build paths for expense accounts to detect tax accounts
        const taxExpenseGuids = new Set<string>();
        for (const guid of expenseGuids) {
            const path = buildAccountPath(guid, accountMap);
            if (isTaxAccount(path)) {
                taxExpenseGuids.add(guid);
            }
        }

        const allRelevantGuids = [...incomeGuids, ...expenseGuids];

        // Build currency map for income/expense accounts
        const accountCurrencyMap = new Map<string, string>();
        for (const acc of relevantAccounts) {
            if (acc.commodity_guid) {
                accountCurrencyMap.set(acc.guid, acc.commodity_guid);
            }
        }

        // Get base currency and pre-fetch exchange rates
        const baseCurrency = await getBaseCurrency();
        if (!baseCurrency) {
            return NextResponse.json({ error: 'No base currency found' }, { status: 500 });
        }
        const nonBaseCurrencyGuids = new Set<string>();
        for (const currGuid of accountCurrencyMap.values()) {
            if (currGuid !== baseCurrency.guid) {
                nonBaseCurrencyGuids.add(currGuid);
            }
        }

        const exchangeRates = new Map<string, number>();
        for (const currGuid of nonBaseCurrencyGuids) {
            const rate = await findExchangeRate(currGuid, baseCurrency.guid, endDate);
            if (rate) {
                exchangeRates.set(currGuid, rate.rate);
            }
        }

        // Per-account, per-month split sums, summed in PostgreSQL `numeric`
        // with a single float8 cast at the boundary. This used to fetch every
        // split in the window and reduce them in JS, which scaled with the
        // transaction count rather than with the size of the answer.
        const monthlySums = await sumSplitsByAccountAndMonth(allRelevantGuids, {
            gte: startDate,
            lte: endDate,
        });

        // Per-account multiplier into the base currency; the previous code
        // resolved this per split from the same two maps.
        const ratesByAccount = new Map<string, number>();
        for (const [accountGuid, currGuid] of accountCurrencyMap) {
            if (currGuid === baseCurrency.guid) continue;
            ratesByAccount.set(accountGuid, exchangeRates.get(currGuid) || 1);
        }

        const monthly = buildMonthlySeries(monthlySums, {
            incomeGuids,
            expenseGuids,
            taxExpenseGuids,
            ratesByAccount,
            startDate,
            endDate,
        });

        const responseData = { monthly };

        // Cache the result (24 hour TTL)
        await cacheSet(cacheKey, responseData, 86400);

        return NextResponse.json(responseData);
    } catch (error) {
        console.error('Error fetching income/expense data:', error);
        return NextResponse.json(
            { error: 'Failed to fetch income/expense data' },
            { status: 500 }
        );
    }
}
