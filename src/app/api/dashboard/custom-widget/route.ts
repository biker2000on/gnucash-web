import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { buildAccountValuationContext } from '@/lib/account-valuation';
import {
    SPEND_DAYS_OPTIONS,
    SERIES_MONTHS_OPTIONS,
    DEFAULT_SERIES_MONTHS,
    MAX_CUSTOM_WIDGET_ACCOUNTS,
    type CustomWidgetMode,
    type SpendDays,
    type SeriesMonths,
} from '@/lib/dashboard-widgets';

interface RowResult {
    account_guid: string;
    account_type: string;
    commodity_guid: string | null;
    commodity_namespace: string | null;
    total_balance: string;
    period_balance: string;
}

interface SeriesRowResult {
    month: string; // 'YYYY-MM'
    account_type: string;
    commodity_guid: string | null;
    commodity_namespace: string | null;
    amount: string;
}

/** 'YYYY-MM' key for a date, evaluated in server-local time (matches to_char). */
function monthKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Last `months` month keys ending at the current month, ascending. */
function trailingMonthKeys(months: number, now: Date): string[] {
    const keys: string[] = [];
    for (let i = months - 1; i >= 0; i--) {
        keys.push(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)));
    }
    return keys;
}

/**
 * GET /api/dashboard/custom-widget?ids=<guid,guid,...>&mode=balance|spend&days=30|90|365
 *
 * Evaluates a user-defined dashboard stat widget server-side (book-scoped).
 *
 *   mode=balance  value = sum of the accounts' current balances, converted to
 *                 the report currency via the shared valuation context.
 *   mode=spend    value = sign-corrected activity total over the trailing
 *                 `days` window (income negated so "spend"/net flows read
 *                 positively the way users expect).
 *
 * Series variant (chart-type widgets):
 *   GET /api/dashboard/custom-widget?ids=...&mode=...&viz=series&months=6|12|24
 *
 * Returns `{ series: [{ month: 'YYYY-MM', value }], mode, months, accountCount, asOf }`
 * with exactly `months` points ending at the current month:
 *   mode=balance  end-of-month cumulative balance of the selected accounts
 *                 (activity before the window folds into an opening balance).
 *   mode=spend    per-month sign-corrected activity total.
 * Commodity balances use current-price valuation for every month (same
 * approximation as the stat variant).
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const searchParams = request.nextUrl.searchParams;

        const mode = searchParams.get('mode') as CustomWidgetMode | null;
        if (mode !== 'balance' && mode !== 'spend') {
            return NextResponse.json({ error: 'mode must be "balance" or "spend"' }, { status: 400 });
        }

        const daysParam = parseInt(searchParams.get('days') ?? '', 10);
        const days: SpendDays = SPEND_DAYS_OPTIONS.includes(daysParam as SpendDays)
            ? (daysParam as SpendDays)
            : 90;

        const isSeries = searchParams.get('viz') === 'series';
        const monthsParam = parseInt(searchParams.get('months') ?? '', 10);
        const months: SeriesMonths = SERIES_MONTHS_OPTIONS.includes(monthsParam as SeriesMonths)
            ? (monthsParam as SeriesMonths)
            : DEFAULT_SERIES_MONTHS;

        const idsParam = searchParams.get('ids') ?? '';
        const requestedIds = [
            ...new Set(idsParam.split(',').map(s => s.trim()).filter(Boolean)),
        ].slice(0, MAX_CUSTOM_WIDGET_ACCOUNTS);
        if (requestedIds.length === 0) {
            return NextResponse.json({ error: 'ids is required' }, { status: 400 });
        }

        // Book-scope: silently ignore accounts outside the active book.
        const bookAccountGuids = await getBookAccountGuids();
        const bookSet = new Set(bookAccountGuids);
        const ids = requestedIds.filter(id => bookSet.has(id));

        const asOf = new Date();

        if (isSeries) {
            const keys = trailingMonthKeys(months, asOf);
            if (ids.length === 0) {
                return NextResponse.json({
                    series: keys.map(month => ({ month, value: 0 })),
                    mode,
                    months,
                    accountCount: 0,
                    asOf: asOf.toISOString(),
                });
            }

            // Balance needs full history (pre-window activity folds into an
            // opening balance); spend only needs the window itself.
            const windowStart = new Date(asOf.getFullYear(), asOf.getMonth() - (months - 1), 1);
            const seriesCutoff = mode === 'balance' ? new Date('1970-01-01') : windowStart;

            const seriesRows = await prisma.$queryRaw<SeriesRowResult[]>`
                SELECT
                    to_char(t.post_date, 'YYYY-MM') as month,
                    a.account_type,
                    a.commodity_guid,
                    c.namespace as commodity_namespace,
                    SUM(CAST(s.quantity_num AS DECIMAL) / CAST(s.quantity_denom AS DECIMAL))::text as amount
                FROM splits s
                JOIN transactions t ON s.tx_guid = t.guid
                JOIN accounts a ON s.account_guid = a.guid
                LEFT JOIN commodities c ON a.commodity_guid = c.guid
                WHERE s.account_guid = ANY(${ids}::text[])
                  AND t.post_date >= ${seriesCutoff}
                GROUP BY 1, a.account_type, a.commodity_guid, c.namespace
            `;

            const valuation = await buildAccountValuationContext(
                seriesRows.map(row => ({
                    accountType: row.account_type,
                    commodityGuid: row.commodity_guid,
                    commodityNamespace: row.commodity_namespace,
                }))
            );

            const firstKey = keys[0];
            const lastKey = keys[keys.length - 1];
            const deltas = new Map<string, number>(keys.map(k => [k, 0]));
            let opening = 0;

            for (const row of seriesRows) {
                const raw = parseFloat(row.amount);
                if (!Number.isFinite(raw) || !row.month) continue;
                const multiplier = valuation.getMultiplier({
                    accountType: row.account_type,
                    commodityGuid: row.commodity_guid,
                    commodityNamespace: row.commodity_namespace,
                });
                // Sign-correct spend: GnuCash stores income as negative credits.
                const signed = mode === 'spend' && row.account_type === 'INCOME' ? -raw : raw;
                const converted = signed * multiplier;

                if (row.month < firstKey) {
                    if (mode === 'balance') opening += converted;
                    continue;
                }
                if (row.month > lastKey) continue; // future-dated transactions
                deltas.set(row.month, (deltas.get(row.month) ?? 0) + converted);
            }

            let running = opening;
            const series = keys.map(month => {
                const delta = deltas.get(month) ?? 0;
                if (mode === 'balance') {
                    running += delta;
                    return { month, value: Math.round(running * 100) / 100 };
                }
                return { month, value: Math.round(delta * 100) / 100 };
            });

            return NextResponse.json({
                series,
                mode,
                months,
                accountCount: ids.length,
                asOf: asOf.toISOString(),
            });
        }

        if (ids.length === 0) {
            return NextResponse.json({
                value: 0,
                mode,
                ...(mode === 'spend' ? { days } : {}),
                accountCount: 0,
                asOf: asOf.toISOString(),
            });
        }

        const cutoff =
            mode === 'spend'
                ? new Date(asOf.getTime() - days * 86_400_000)
                : new Date('1970-01-01');

        const rows = await prisma.$queryRaw<RowResult[]>`
            SELECT
                s.account_guid,
                a.account_type,
                a.commodity_guid,
                c.namespace as commodity_namespace,
                SUM(CAST(s.quantity_num AS DECIMAL) / CAST(s.quantity_denom AS DECIMAL))::text as total_balance,
                SUM(
                    CASE
                        WHEN t.post_date >= ${cutoff}
                        THEN CAST(s.quantity_num AS DECIMAL) / CAST(s.quantity_denom AS DECIMAL)
                        ELSE 0
                    END
                )::text as period_balance
            FROM splits s
            JOIN transactions t ON s.tx_guid = t.guid
            JOIN accounts a ON s.account_guid = a.guid
            LEFT JOIN commodities c ON a.commodity_guid = c.guid
            WHERE s.account_guid = ANY(${ids}::text[])
            GROUP BY s.account_guid, a.account_type, a.commodity_guid, c.namespace
        `;

        // Convert commodity-denominated balances (stocks, foreign currency)
        // into the report currency, same as /api/accounts/balances.
        const valuation = await buildAccountValuationContext(
            rows.map(row => ({
                accountType: row.account_type,
                commodityGuid: row.commodity_guid,
                commodityNamespace: row.commodity_namespace,
            }))
        );

        let value = 0;
        for (const row of rows) {
            const raw = parseFloat(mode === 'balance' ? row.total_balance : row.period_balance);
            if (!Number.isFinite(raw)) continue;
            const multiplier = valuation.getMultiplier({
                accountType: row.account_type,
                commodityGuid: row.commodity_guid,
                commodityNamespace: row.commodity_namespace,
            });
            // Sign-correct spend: GnuCash stores income as negative credits.
            const signed = mode === 'spend' && row.account_type === 'INCOME' ? -raw : raw;
            value += signed * multiplier;
        }

        return NextResponse.json({
            value: Math.round(value * 100) / 100,
            mode,
            ...(mode === 'spend' ? { days } : {}),
            accountCount: rows.length,
            asOf: asOf.toISOString(),
        });
    } catch (error) {
        console.error('Error evaluating custom dashboard widget:', error);
        return NextResponse.json({ error: 'Failed to evaluate custom widget' }, { status: 500 });
    }
}
