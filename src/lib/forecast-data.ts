/**
 * Cash Flow Forecast — data loading
 *
 * Loads everything the pure engine in `forecast.ts` needs from the
 * GnuCash database: cash-like accounts with current balances, a 90-day
 * historical run rate per account (excluding transactions that came from
 * scheduled transactions, where identifiable), and upcoming scheduled
 * transaction occurrences via the shared recurrence engine.
 */

import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';
import { fetchScheduledTransactions } from '@/lib/scheduled-transactions';
import {
    computeForecast,
    computeDailyRunRates,
    expandScheduledEvents,
    type ForecastAccount,
    type ForecastResult,
    type HistoricalFlow,
} from './forecast';

/** Account types treated as "cash-like" by default. */
export const CASH_ACCOUNT_TYPES = ['BANK', 'CASH', 'CREDIT'];

const DEFAULT_LOOKBACK_DAYS = 90;

export interface ForecastResponse extends ForecastResult {
    /** All cash-like accounts in the active book (for the account picker). */
    availableAccounts: Array<{ guid: string; name: string; accountType: string }>;
    /** How the historical run rate was computed. */
    runRateNote: string;
    lookbackDays: number;
}

export interface LoadForecastOptions {
    bookAccountGuids: string[];
    /** Explicit account selection; null/undefined = all cash-like accounts. */
    accountGuids?: string[] | null;
    horizonDays: number;
    threshold?: number;
    lookbackDays?: number;
}

interface AccountRow {
    guid: string;
    name: string;
    account_type: string;
}

/**
 * Sum split quantities per account up to `asOf` (current balances).
 */
async function loadBalances(accountGuids: string[], asOf: Date): Promise<Map<string, number>> {
    const balances = new Map<string, number>();
    if (accountGuids.length === 0) return balances;

    const rows = await prisma.$queryRaw<Array<{ account_guid: string; balance: unknown }>>`
        SELECT s.account_guid,
               SUM(CAST(s.quantity_num AS numeric) / NULLIF(s.quantity_denom, 0)) AS balance
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE s.account_guid IN (${Prisma.join(accountGuids)})
          AND t.post_date <= ${asOf}
        GROUP BY s.account_guid
    `;

    for (const row of rows) {
        const value = parseFloat(String(row.balance ?? '0'));
        balances.set(row.account_guid, Number.isFinite(value) ? value : 0);
    }
    return balances;
}

/**
 * Net flows per account over the lookback window, excluding transactions
 * that originated from scheduled transactions where identifiable:
 * - transactions tagged with GnuCash's `from-sched-xaction` slot, and
 * - transactions whose description exactly matches a scheduled
 *   transaction name (the pattern this app's execute path uses).
 */
async function loadHistoricalFlows(
    accountGuids: string[],
    start: Date,
    end: Date
): Promise<HistoricalFlow[]> {
    if (accountGuids.length === 0) return [];

    const [splits, sxTaggedSlots, sxNameRows] = await Promise.all([
        prisma.splits.findMany({
            where: {
                account_guid: { in: accountGuids },
                transaction: { post_date: { gt: start, lte: end } },
            },
            select: {
                account_guid: true,
                quantity_num: true,
                quantity_denom: true,
                tx_guid: true,
                transaction: { select: { description: true } },
            },
        }),
        prisma.slots.findMany({
            where: { name: 'from-sched-xaction' },
            select: { obj_guid: true },
        }),
        prisma.schedxactions.findMany({ select: { name: true } }),
    ]);

    const sxTaggedTxGuids = new Set(sxTaggedSlots.map(s => s.obj_guid));
    const sxNames = new Set(
        sxNameRows.map(r => r.name).filter((n): n is string => !!n)
    );

    const flows: HistoricalFlow[] = [];
    for (const split of splits) {
        if (sxTaggedTxGuids.has(split.tx_guid)) continue;
        const description = split.transaction?.description;
        if (description && sxNames.has(description)) continue;

        flows.push({
            accountGuid: split.account_guid,
            amount: parseFloat(toDecimal(split.quantity_num, split.quantity_denom)),
        });
    }
    return flows;
}

/**
 * Load all forecast inputs from the database and run the projection.
 */
export async function loadForecastData(options: LoadForecastOptions): Promise<ForecastResponse> {
    const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const lookbackStart = new Date(
        startDate.getFullYear(),
        startDate.getMonth(),
        startDate.getDate() - lookbackDays
    );

    // All cash-like accounts in the book (always returned, for the picker)
    const cashAccounts = await prisma.accounts.findMany({
        where: {
            guid: { in: options.bookAccountGuids },
            account_type: { in: CASH_ACCOUNT_TYPES },
            hidden: 0,
        },
        select: { guid: true, name: true, account_type: true },
        orderBy: { name: 'asc' },
    });

    // Selected accounts: explicit list (scoped to the book) or all cash-like
    let selectedRows: AccountRow[];
    if (options.accountGuids && options.accountGuids.length > 0) {
        const bookSet = new Set(options.bookAccountGuids);
        const requested = options.accountGuids.filter(g => bookSet.has(g));
        selectedRows = await prisma.accounts.findMany({
            where: { guid: { in: requested } },
            select: { guid: true, name: true, account_type: true },
            orderBy: { name: 'asc' },
        });
    } else {
        selectedRows = cashAccounts;
    }

    const selectedGuids = selectedRows.map(a => a.guid);
    const selectedSet = new Set(selectedGuids);

    const [balances, flows, scheduled] = await Promise.all([
        loadBalances(selectedGuids, now),
        loadHistoricalFlows(selectedGuids, lookbackStart, now),
        fetchScheduledTransactions(true),
    ]);

    const accounts: ForecastAccount[] = selectedRows.map(row => ({
        guid: row.guid,
        name: row.name,
        currentBalance: balances.get(row.guid) || 0,
        excludeFromWarnings: row.account_type === 'CREDIT',
    }));

    const runRates = computeDailyRunRates(flows, lookbackDays);
    const events = expandScheduledEvents(scheduled, selectedSet, startDate, options.horizonDays);

    const result = computeForecast({
        accounts,
        events,
        runRates,
        horizonDays: options.horizonDays,
        threshold: options.threshold,
        startDate,
    });

    return {
        ...result,
        availableAccounts: cashAccounts.map(a => ({
            guid: a.guid,
            name: a.name,
            accountType: a.account_type,
        })),
        runRateNote:
            `Run rate is the average daily net flow over the past ${lookbackDays} days, ` +
            `excluding transactions tagged as scheduled-transaction instances or matching ` +
            `a scheduled transaction name (to avoid double counting). Untagged instances ` +
            `with edited descriptions may still be included.`,
        lookbackDays,
    };
}
