import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getPreference } from '@/lib/user-preferences';
import prisma from '@/lib/prisma';
import { expandMappingsToDescendants } from '@/lib/tax/book-income';
import { isTaxCategory, type TaxCategory } from '@/lib/tax/types';
import {
    estimateSocialSecurityBenefit,
    type EarningsRecord,
} from '@/lib/fire/social-security';
import type { Bucket, BucketAmounts } from '@/lib/drawdown/types';

/**
 * GET /api/tools/drawdown/prefill
 *
 * Prefills the Retirement Drawdown planner from the active book:
 * - Starting balances by bucket (taxable / traditional / Roth / HSA).
 *   Buckets come from account preferences (is_retirement +
 *   retirement_account_type), inherited from the nearest flagged ancestor.
 *   Unflagged STOCK/MUTUAL holdings are taxable; unflagged cash accounts
 *   are taxable only when their path looks like a brokerage.
 * - Social Security annual benefit per claiming age (62-70) from the book
 *   earnings history, following /api/fire/social-security.
 * - Birthday-derived current age when the preference is set.
 */

const CASH_TYPES = new Set(['ASSET', 'BANK', 'CASH']);
const INVESTMENT_TYPES = new Set(['STOCK', 'MUTUAL']);

const TRADITIONAL_TYPES = new Set(['401k', '403b', '457', 'traditional_ira', 'sep_ira', 'simple_ira']);
const ROTH_TYPES = new Set(['roth_ira', 'roth_401k']);
const HSA_TYPES = new Set(['hsa', 'hsa_family']);
const TAXABLE_TYPES = new Set(['brokerage']);

const BROKERAGE_PATH_PATTERN = /brokerage|invest/i;
const EARNINGS_CATEGORIES: ReadonlySet<TaxCategory> = new Set(['w2_wages', 'self_employment_income']);
const EARNINGS_NAME_PATTERN = /salary|wages|paycheck|payroll/i;

interface AccountRow {
    guid: string;
    name: string;
    parent_guid: string | null;
    account_type: string;
    hidden: number | null;
    commodity_guid: string | null;
    commodity: { namespace: string } | null;
}

function bucketForRetirementType(type: string | null): Bucket | null {
    if (!type) return null;
    if (TRADITIONAL_TYPES.has(type)) return 'traditional';
    if (ROTH_TYPES.has(type)) return 'roth';
    if (HSA_TYPES.has(type)) return 'hsa';
    if (TAXABLE_TYPES.has(type)) return 'taxable';
    return null; // 529 / ESA / FSA / HRA: not retirement drawdown money
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const userId = roleResult.user.id;

        const [bookAccountGuids, birthday] = await Promise.all([
            getBookAccountGuids(),
            getPreference<string | null>(userId, 'birthday', null),
        ]);

        const accounts = await prisma.accounts.findMany({
            where: { guid: { in: bookAccountGuids } },
            select: {
                guid: true,
                name: true,
                parent_guid: true,
                account_type: true,
                hidden: true,
                commodity_guid: true,
                commodity: { select: { namespace: true } },
            },
        });
        const accountMap = new Map<string, AccountRow>(accounts.map(a => [a.guid, a]));

        /* --- Full path for each account (ROOT excluded) --- */
        function pathOf(guid: string): string {
            const parts: string[] = [];
            let current: AccountRow | undefined = accountMap.get(guid);
            let hops = 0;
            while (current && current.account_type !== 'ROOT' && hops < 32) {
                parts.unshift(current.name);
                current = current.parent_guid ? accountMap.get(current.parent_guid) : undefined;
                hops += 1;
            }
            return parts.join(':');
        }

        /* --- Retirement flags, inherited from the nearest flagged ancestor --- */
        const prefs = await prisma.gnucash_web_account_preferences.findMany({
            where: { account_guid: { in: bookAccountGuids }, is_retirement: true },
            select: { account_guid: true, retirement_account_type: true },
        });
        const flaggedType = new Map(prefs.map(p => [p.account_guid, p.retirement_account_type]));

        function effectiveRetirementType(guid: string): string | null {
            let current: AccountRow | undefined = accountMap.get(guid);
            let hops = 0;
            while (current && hops < 32) {
                const type = flaggedType.get(current.guid);
                if (type !== undefined) return type;
                current = current.parent_guid ? accountMap.get(current.parent_guid) : undefined;
                hops += 1;
            }
            return null;
        }

        /* --- Classify balance-carrying accounts into buckets --- */
        interface Classified {
            account: AccountRow;
            bucket: Bucket;
            path: string;
            isShares: boolean;
        }
        const classified: Classified[] = [];
        for (const account of accounts) {
            if ((account.hidden ?? 0) !== 0) continue;
            const isCash = CASH_TYPES.has(account.account_type);
            const isInvestment = INVESTMENT_TYPES.has(account.account_type);
            if (!isCash && !isInvestment) continue;

            const isShares = isInvestment && account.commodity?.namespace !== 'CURRENCY';
            const path = pathOf(account.guid);
            const retirementType = effectiveRetirementType(account.guid);

            let bucket: Bucket | null;
            if (retirementType !== null) {
                bucket = bucketForRetirementType(retirementType);
            } else if (isShares) {
                bucket = 'taxable';
            } else if (isCash && BROKERAGE_PATH_PATTERN.test(path)) {
                bucket = 'taxable';
            } else {
                bucket = null; // regular checking/savings: not drawdown assets
            }
            if (bucket === null) continue;
            classified.push({ account, bucket, path, isShares });
        }

        /* --- Quantities per account (shares for STOCK/MUTUAL, cash otherwise) --- */
        const balanceGuids = classified.map(c => c.account.guid);
        const qtyByAccount = new Map<string, number>();
        if (balanceGuids.length > 0) {
            const qtyRows = await prisma.$queryRaw<Array<{ account_guid: string; qty: number | null }>>`
                SELECT s.account_guid,
                       SUM(s.quantity_num::numeric / s.quantity_denom)::float8 AS qty
                FROM splits s
                JOIN transactions t ON s.tx_guid = t.guid
                WHERE s.account_guid = ANY(${balanceGuids})
                  AND t.post_date <= NOW()
                GROUP BY s.account_guid
            `;
            for (const row of qtyRows) {
                if (row.qty !== null) qtyByAccount.set(row.account_guid, row.qty);
            }
        }

        /* --- Latest price per commodity for share-denominated accounts --- */
        const commodityGuids = [...new Set(
            classified
                .filter(c => c.isShares && c.account.commodity_guid !== null)
                .map(c => c.account.commodity_guid as string),
        )];
        const priceByCommodity = new Map<string, number>();
        if (commodityGuids.length > 0) {
            const priceRows = await prisma.$queryRaw<Array<{ commodity_guid: string; price: number | null }>>`
                SELECT DISTINCT ON (commodity_guid)
                       commodity_guid,
                       (value_num::numeric / value_denom)::float8 AS price
                FROM prices
                WHERE commodity_guid = ANY(${commodityGuids})
                  AND value_num > 0
                ORDER BY commodity_guid, date DESC
            `;
            for (const row of priceRows) {
                if (row.price !== null) priceByCommodity.set(row.commodity_guid, row.price);
            }
        }

        /* --- Sum balances per bucket --- */
        const balances: BucketAmounts = { taxable: 0, traditional: 0, roth: 0, hsa: 0 };
        const accountDetails: Array<{
            guid: string;
            name: string;
            path: string;
            bucket: Bucket;
            balance: number;
        }> = [];
        for (const c of classified) {
            const qty = qtyByAccount.get(c.account.guid) ?? 0;
            const balance = c.isShares
                ? qty * (c.account.commodity_guid
                    ? priceByCommodity.get(c.account.commodity_guid) ?? 0
                    : 0)
                : qty;
            if (Math.abs(balance) < 0.005) continue;
            balances[c.bucket] += balance;
            accountDetails.push({
                guid: c.account.guid,
                name: c.account.name,
                path: c.path,
                bucket: c.bucket,
                balance: round2(balance),
            });
        }
        for (const key of Object.keys(balances) as Bucket[]) {
            balances[key] = round2(Math.max(0, balances[key]));
        }
        accountDetails.sort((a, b) => b.balance - a.balance);

        /* --- Social Security from book earnings (mirrors /api/fire/social-security) --- */
        const mappingRows = await prisma.gnucash_web_tax_mappings.findMany({
            where: { account_guid: { in: bookAccountGuids } },
        });
        const directMappings = new Map<string, TaxCategory>();
        for (const row of mappingRows) {
            if (isTaxCategory(row.tax_category)) directMappings.set(row.account_guid, row.tax_category);
        }
        const expanded = expandMappingsToDescendants(directMappings, accounts);
        let earningsGuids = [...expanded.entries()]
            .filter(([, category]) => EARNINGS_CATEGORIES.has(category))
            .map(([guid]) => guid);
        if (earningsGuids.length === 0) {
            earningsGuids = accounts
                .filter(a =>
                    a.account_type === 'INCOME' &&
                    (EARNINGS_NAME_PATTERN.test(a.name) || EARNINGS_NAME_PATTERN.test(pathOf(a.guid))))
                .map(a => a.guid);
        }

        const earningsByYear = new Map<number, number>();
        if (earningsGuids.length > 0) {
            const yearSums = await prisma.$queryRaw<Array<{
                account_guid: string;
                year: number;
                total: number | null;
            }>>`
                SELECT s.account_guid,
                       EXTRACT(YEAR FROM t.post_date)::int AS year,
                       (SUM(s.value_num::numeric / s.value_denom))::float8 AS total
                FROM splits s
                JOIN transactions t ON s.tx_guid = t.guid
                WHERE s.account_guid = ANY(${earningsGuids})
                GROUP BY s.account_guid, year
            `;
            for (const row of yearSums) {
                if (row.total === null || !Number.isFinite(row.year)) continue;
                const info = accountMap.get(row.account_guid);
                // INCOME accounts carry credits (negative) for money earned — negate.
                const amount = info?.account_type === 'INCOME' ? -row.total : row.total;
                earningsByYear.set(row.year, (earningsByYear.get(row.year) ?? 0) + amount);
            }
        }
        const earningsYears: EarningsRecord[] = [...earningsByYear.entries()]
            .map(([year, earnings]) => ({ year, earnings: round2(earnings) }))
            .filter(r => r.earnings > 0)
            .sort((a, b) => a.year - b.year);

        const birthYear = birthday ? parseInt(birthday.slice(0, 4), 10) : null;
        const ssAvailable =
            birthYear !== null && Number.isFinite(birthYear) && earningsYears.length > 0;

        let socialSecurity:
            | { available: true; birthYear: number; annualBenefitByClaimAge: Record<number, number> }
            | { available: false; reason: 'no_birthday' | 'no_earnings' };
        if (ssAvailable) {
            const annualBenefitByClaimAge: Record<number, number> = {};
            for (let claimingAge = 62; claimingAge <= 70; claimingAge++) {
                const estimate = estimateSocialSecurityBenefit({
                    earnings: earningsYears,
                    birthYear: birthYear!,
                    claimingAge,
                    projectFutureEarnings: true,
                });
                annualBenefitByClaimAge[claimingAge] = estimate.annualBenefit;
            }
            socialSecurity = { available: true, birthYear: birthYear!, annualBenefitByClaimAge };
        } else {
            socialSecurity = { available: false, reason: !birthYear ? 'no_birthday' : 'no_earnings' };
        }

        /* --- Birthday-derived current age --- */
        let currentAge: number | null = null;
        if (birthday) {
            const ageYears = Math.floor(
                (Date.now() - new Date(birthday + 'T00:00:00').getTime()) /
                (365.25 * 24 * 60 * 60 * 1000),
            );
            if (ageYears > 0 && ageYears < 120) currentAge = ageYears;
        }

        return NextResponse.json({
            balances,
            accounts: accountDetails,
            birthday,
            currentAge,
            socialSecurity,
        });
    } catch (error) {
        console.error('Error prefilling drawdown planner:', error);
        return NextResponse.json(
            { error: 'Failed to prefill drawdown planner' },
            { status: 500 },
        );
    }
}
