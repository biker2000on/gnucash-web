import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { buildAccountValuationContext } from '@/lib/account-valuation';
import {
    SPEND_DAYS_OPTIONS,
    MAX_CUSTOM_WIDGET_ACCOUNTS,
    type CustomWidgetMode,
    type SpendDays,
} from '@/lib/dashboard-widgets';

interface RowResult {
    account_guid: string;
    account_type: string;
    commodity_guid: string | null;
    commodity_namespace: string | null;
    total_balance: string;
    period_balance: string;
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
