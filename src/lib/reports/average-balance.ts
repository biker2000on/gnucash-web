import prisma from '@/lib/prisma';
import { buildAccountPathMap } from './utils';

/**
 * Average Balance report.
 *
 * For a set of accounts (default: all visible BANK/CASH/ASSET current
 * accounts) and a date range, walks the combined daily balance from split
 * deltas and reports the average daily balance, minimum, maximum, and ending
 * balance per calendar month. The starting balance is the sum of all splits
 * posted before the range start.
 */

export interface BalanceDelta {
    /** YYYY-MM-DD (UTC calendar date of the transaction post_date). */
    date: string;
    amount: number;
}

export interface AverageBalanceBucket {
    /** YYYY-MM. */
    month: string;
    /** Display label, e.g. "Jan 2026". */
    label: string;
    /** Average of end-of-day balances over the days of this bucket. */
    average: number;
    min: number;
    max: number;
    /** End-of-day balance on the bucket's last day. */
    ending: number;
    /** Number of days in this bucket that fall inside the range. */
    days: number;
}

export interface AverageBalanceAccountOption {
    guid: string;
    name: string;
    path: string;
    selected: boolean;
}

export interface AverageBalanceData {
    title: string;
    generatedAt: string;
    startDate: string;
    endDate: string;
    openingBalance: number;
    buckets: AverageBalanceBucket[];
    /** Candidate accounts with their selection state (for the account picker). */
    accounts: AverageBalanceAccountOption[];
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;
/** Safety cap on the daily walk (~55 years). */
const MAX_WALK_DAYS = 20_000;

function utcMidnight(dateStr: string): number {
    const [y, m, d] = dateStr.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
}

function isoDate(ms: number): string {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/**
 * Pure daily-balance walk, bucketed by calendar month (UTC).
 * Balances are end-of-day: a delta on day D is included in day D's balance.
 */
export function computeAverageBalance(
    openingBalance: number,
    deltas: BalanceDelta[],
    startDate: string,
    endDate: string,
): AverageBalanceBucket[] {
    const start = utcMidnight(startDate);
    const end = utcMidnight(endDate);
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) return [];

    const deltaByDate = new Map<string, number>();
    for (const delta of deltas) {
        deltaByDate.set(delta.date, (deltaByDate.get(delta.date) ?? 0) + delta.amount);
    }

    interface Interim extends AverageBalanceBucket {
        sum: number;
    }

    const buckets: Interim[] = [];
    let current: Interim | null = null;
    let balance = openingBalance;
    let steps = 0;

    for (let t = start; t <= end && steps++ < MAX_WALK_DAYS; t += DAY_MS) {
        const iso = isoDate(t);
        balance += deltaByDate.get(iso) ?? 0;

        const month = iso.slice(0, 7);
        if (!current || current.month !== month) {
            const monthParts: string[] = month.split('-');
            const y: number = Number(monthParts[0]);
            const m: number = Number(monthParts[1]);
            current = {
                month,
                label: `${MONTH_NAMES[m - 1]} ${y}`,
                average: 0,
                min: balance,
                max: balance,
                ending: balance,
                days: 0,
                sum: 0,
            };
            buckets.push(current);
        }

        current.days += 1;
        current.sum += balance;
        current.min = Math.min(current.min, balance);
        current.max = Math.max(current.max, balance);
        current.ending = balance;
    }

    return buckets.map(({ sum, ...bucket }) => ({
        ...bucket,
        average: bucket.days > 0 ? sum / bucket.days : 0,
    }));
}

export interface GenerateAverageBalanceParams {
    startDate: string;
    endDate: string;
    /** Selected account GUIDs. Undefined/empty → all candidate accounts. */
    accountGuids?: string[] | null;
    bookAccountGuids: string[];
}

const CANDIDATE_ACCOUNT_TYPES = ['BANK', 'CASH', 'ASSET'];

export async function generateAverageBalance(
    params: GenerateAverageBalanceParams,
): Promise<AverageBalanceData> {
    const { startDate, endDate, accountGuids, bookAccountGuids } = params;

    const candidates = await prisma.accounts.findMany({
        where: {
            guid: { in: bookAccountGuids },
            account_type: { in: CANDIDATE_ACCOUNT_TYPES },
            NOT: [{ hidden: 1 }, { placeholder: 1 }],
        },
        select: { guid: true, name: true },
        orderBy: { name: 'asc' },
    });

    const candidateGuids = new Set(candidates.map(a => a.guid));
    const requested = (accountGuids ?? []).filter(guid => candidateGuids.has(guid));
    const selected = requested.length > 0 ? requested : candidates.map(a => a.guid);
    const selectedSet = new Set(selected);

    const paths = await buildAccountPathMap(bookAccountGuids);

    let openingBalance = 0;
    let deltas: BalanceDelta[] = [];
    if (selected.length > 0) {
        const start = new Date(startDate + 'T00:00:00Z');
        const end = new Date(endDate + 'T23:59:59Z');

        const openingRows = await prisma.$queryRaw<Array<{ total: number | null }>>`
            SELECT SUM(s.quantity_num::numeric / NULLIF(s.quantity_denom, 0)::numeric)::float8 AS total
            FROM splits s
            JOIN transactions t ON t.guid = s.tx_guid
            WHERE s.account_guid = ANY(${selected})
              AND t.post_date < ${start}
        `;
        openingBalance = Number(openingRows[0]?.total ?? 0);

        const deltaRows = await prisma.$queryRaw<Array<{ date: string; amount: number | null }>>`
            SELECT to_char(t.post_date, 'YYYY-MM-DD') AS date,
                   SUM(s.quantity_num::numeric / NULLIF(s.quantity_denom, 0)::numeric)::float8 AS amount
            FROM splits s
            JOIN transactions t ON t.guid = s.tx_guid
            WHERE s.account_guid = ANY(${selected})
              AND t.post_date >= ${start}
              AND t.post_date <= ${end}
            GROUP BY 1
        `;
        deltas = deltaRows.map(r => ({ date: r.date, amount: Number(r.amount ?? 0) }));
    }

    const buckets = computeAverageBalance(openingBalance, deltas, startDate, endDate);

    return {
        title: 'Average Balance',
        generatedAt: new Date().toISOString(),
        startDate,
        endDate,
        openingBalance,
        buckets,
        accounts: candidates.map(a => ({
            guid: a.guid,
            name: a.name,
            path: paths.get(a.guid) || a.name,
            selected: selectedSet.has(a.guid),
        })),
    };
}
