import prisma from '@/lib/prisma';

/**
 * Income/Expenses vs Day of Week report.
 *
 * Buckets income and expense flows by the weekday of the transaction
 * post_date (interpreted in UTC — GnuCash stores post dates as timestamps
 * without a timezone) and reports totals plus per-weekday-occurrence
 * averages over the selected date range.
 */

export const WEEKDAY_NAMES = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
] as const;

export interface DayOfWeekFlowRow {
    /** Transaction post date (Date or ISO string). Weekday is taken in UTC. */
    postDate: Date | string;
    /** GnuCash account type of the split's account ('INCOME' | 'EXPENSE'). */
    accountType: string;
    /** Signed sum of split quantities (income negative, expense positive). */
    amount: number;
}

export interface WeekdayBucket {
    /** 0 = Sunday ... 6 = Saturday (UTC). */
    weekday: number;
    name: string;
    /** Positive magnitude of income posted on this weekday. */
    income: number;
    expense: number;
    /** Total divided by the number of times this weekday occurs in the range. */
    incomeAvg: number;
    expenseAvg: number;
    /** How many times this weekday occurs in [startDate, endDate]. */
    occurrences: number;
}

export interface DayOfWeekData {
    title: string;
    generatedAt: string;
    startDate: string;
    endDate: string;
    days: WeekdayBucket[];
    totals: { income: number; expense: number };
}

function utcMidnight(dateStr: string): number {
    const [y, m, d] = dateStr.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
}

const DAY_MS = 86_400_000;

/** Count how many times `weekday` (0=Sun..6=Sat) occurs in [startDate, endDate], inclusive, in UTC. */
export function countWeekdayOccurrences(startDate: string, endDate: string, weekday: number): number {
    const start = utcMidnight(startDate);
    const end = utcMidnight(endDate);
    if (end < start) return 0;

    const days = Math.floor((end - start) / DAY_MS) + 1;
    const startDow = new Date(start).getUTCDay();
    let count = Math.floor(days / 7);
    for (let i = 0; i < days % 7; i++) {
        if ((startDow + i) % 7 === weekday) count++;
    }
    return count;
}

/** Pure bucketing core. */
export function computeDayOfWeek(
    rows: DayOfWeekFlowRow[],
    startDate: string,
    endDate: string,
): { days: WeekdayBucket[]; totals: { income: number; expense: number } } {
    const days: WeekdayBucket[] = WEEKDAY_NAMES.map((name, weekday) => ({
        weekday,
        name,
        income: 0,
        expense: 0,
        incomeAvg: 0,
        expenseAvg: 0,
        occurrences: countWeekdayOccurrences(startDate, endDate, weekday),
    }));

    for (const row of rows) {
        const date = row.postDate instanceof Date ? row.postDate : new Date(row.postDate);
        if (Number.isNaN(date.getTime())) continue;
        const bucket = days[date.getUTCDay()];
        if (row.accountType === 'INCOME') {
            bucket.income += -row.amount; // income splits are stored negative
        } else if (row.accountType === 'EXPENSE') {
            bucket.expense += row.amount;
        }
    }

    let income = 0;
    let expense = 0;
    for (const bucket of days) {
        if (bucket.occurrences > 0) {
            bucket.incomeAvg = bucket.income / bucket.occurrences;
            bucket.expenseAvg = bucket.expense / bucket.occurrences;
        }
        income += bucket.income;
        expense += bucket.expense;
    }

    return { days, totals: { income, expense } };
}

export interface GenerateDayOfWeekParams {
    startDate: string;
    endDate: string;
    bookAccountGuids: string[];
}

export async function generateDayOfWeek(params: GenerateDayOfWeekParams): Promise<DayOfWeekData> {
    const { startDate, endDate, bookAccountGuids } = params;

    const flowAccounts = await prisma.accounts.findMany({
        where: {
            guid: { in: bookAccountGuids },
            account_type: { in: ['INCOME', 'EXPENSE'] },
        },
        select: { guid: true },
    });
    const flowGuids = flowAccounts.map(a => a.guid);

    let rows: DayOfWeekFlowRow[] = [];
    if (flowGuids.length > 0) {
        const start = new Date(startDate + 'T00:00:00Z');
        const end = new Date(endDate + 'T23:59:59Z');
        const raw = await prisma.$queryRaw<
            Array<{ post_date: Date; account_type: string; amount: number | null }>
        >`
            SELECT t.post_date AS post_date,
                   a.account_type AS account_type,
                   SUM(s.quantity_num::numeric / NULLIF(s.quantity_denom, 0)::numeric)::float8 AS amount
            FROM splits s
            JOIN accounts a ON a.guid = s.account_guid
            JOIN transactions t ON t.guid = s.tx_guid
            WHERE s.account_guid = ANY(${flowGuids})
              AND t.post_date >= ${start}
              AND t.post_date <= ${end}
            GROUP BY t.post_date, a.account_type
        `;
        rows = raw.map(r => ({
            postDate: r.post_date,
            accountType: r.account_type,
            amount: Number(r.amount ?? 0),
        }));
    }

    const { days, totals } = computeDayOfWeek(rows, startDate, endDate);

    return {
        title: 'Income & Expenses by Day of Week',
        generatedAt: new Date().toISOString(),
        startDate,
        endDate,
        days,
        totals,
    };
}
