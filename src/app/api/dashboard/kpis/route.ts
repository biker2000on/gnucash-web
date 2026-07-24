import { NextRequest, NextResponse } from 'next/server';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { getEffectiveStartDate } from '@/lib/date-utils';
import { cacheGet, cacheSet } from '@/lib/cache';
import { requireRole } from '@/lib/auth';
import { FinancialSummaryService } from '@/lib/services/financial-summary.service';
import prisma from '@/lib/prisma';
import {
    createCalculationTrace,
    persistCalculationTraces,
} from '@/lib/provenance';

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
        const bookAccountGuids = await getAccountGuidsForBook(roleResult.bookGuid);
        const startDate = await getEffectiveStartDate(startDateParam, bookAccountGuids);

        // Build cache key from book guid + metric + date params
        const bookGuid = roleResult.bookGuid;
        const dateRange = `${startDate.toISOString().split('T')[0]}-${endDate.toISOString().split('T')[0]}`;
        const cacheKey = `cache:${bookGuid}:user:${roleResult.user.id}:kpis:v2:${dateRange}`;

        // Check cache first
        const cached = await cacheGet(cacheKey);
        if (cached) {
            return NextResponse.json(cached);
        }

        const summary = await FinancialSummaryService.computeFullSummary(
            bookAccountGuids,
            startDate,
            endDate
        );

        const heldCommodityPrices = await prisma.$queryRaw<Array<{
            commodity_guid: string;
            symbol: string;
            latest_price_at: Date | null;
        }>>`
            WITH held_commodities AS (
                SELECT
                    a.commodity_guid,
                    c.mnemonic AS symbol,
                    SUM(
                        s.quantity_num::numeric
                        / NULLIF(s.quantity_denom, 0)::numeric
                    ) AS quantity
                FROM accounts a
                JOIN commodities c ON c.guid = a.commodity_guid
                JOIN splits s ON s.account_guid = a.guid
                JOIN transactions t ON t.guid = s.tx_guid
                WHERE a.guid = ANY(${bookAccountGuids}::text[])
                  AND a.account_type IN ('STOCK', 'MUTUAL')
                  AND COALESCE(a.hidden, 0) = 0
                  AND c.namespace <> 'CURRENCY'
                  AND t.post_date <= ${endDate}
                GROUP BY a.commodity_guid, c.mnemonic
                HAVING ABS(SUM(
                    s.quantity_num::numeric
                    / NULLIF(s.quantity_denom, 0)::numeric
                )) > 0.00000001
            ),
            latest_prices AS (
                SELECT DISTINCT ON (p.commodity_guid)
                    p.commodity_guid,
                    p.date
                FROM prices p
                JOIN held_commodities held
                  ON held.commodity_guid = p.commodity_guid
                WHERE p.value_num > 0
                  AND p.date <= ${endDate}
                ORDER BY p.commodity_guid, p.date DESC
            )
            SELECT
                held.commodity_guid,
                held.symbol,
                price.date AS latest_price_at
            FROM held_commodities held
            LEFT JOIN latest_prices price
              ON price.commodity_guid = held.commodity_guid
            ORDER BY held.symbol
        `;
        const priceEvidence = heldCommodityPrices.map(row => {
            const ageDays = row.latest_price_at
                ? Math.max(0, Math.floor(
                    (endDate.getTime() - row.latest_price_at.getTime()) / 86_400_000
                ))
                : null;
            return {
                kind: 'price' as const,
                id: row.commodity_guid,
                label: row.latest_price_at
                    ? `${row.symbol} price from ${row.latest_price_at.toISOString().slice(0, 10)}`
                    : `${row.symbol} has no positive market price`,
                source: 'market_price' as const,
                href: '/reports/price_history',
                observedAt: row.latest_price_at?.toISOString(),
                stale: ageDays === null || ageDays > 7,
                metadata: { symbol: row.symbol, ageDays },
            };
        });
        const priceWarnings = heldCommodityPrices.flatMap(row => {
            if (!row.latest_price_at) {
                return [`${row.symbol} has no positive market price on or before the selected date.`];
            }
            const ageDays = Math.max(0, Math.floor(
                (endDate.getTime() - row.latest_price_at.getTime()) / 86_400_000
            ));
            return ageDays > 7
                ? [`${row.symbol}'s price is ${ageDays} days old.`]
                : [];
        });
        const commonEvidence = [{
            kind: 'report_query' as const,
            id: `dashboard-kpis:${dateRange}`,
            label: `Active-book transactions from ${startDate.toISOString().slice(0, 10)} through ${endDate.toISOString().slice(0, 10)}`,
            source: 'system' as const,
            href: `/ledger?startDate=${startDate.toISOString().slice(0, 10)}&endDate=${endDate.toISOString().slice(0, 10)}`,
            observedAt: new Date().toISOString(),
            verified: false,
            metadata: { accountCount: bookAccountGuids.length },
        }];
        const traces = {
            netWorth: createCalculationTrace({
                namespace: 'dashboard-kpi',
                identity: { bookGuid, metric: 'net-worth', dateRange },
                title: 'Net worth',
                summary: 'Assets plus investment market value plus liability balances as of the selected date.',
                asOfDate: endDate.toISOString().slice(0, 10),
                formula: 'assets + investment value + liabilities',
                result: summary.netWorth,
                unit: 'currency',
                steps: [{
                    key: 'net-worth',
                    label: 'Combine balance-sheet accounts',
                    formula: 'assets + investments + liabilities',
                    inputs: {
                        investmentValue: summary.investmentValue,
                        changeDuringPeriod: summary.netWorthChange,
                    },
                    result: summary.netWorth,
                }],
                evidence: [
                    ...commonEvidence,
                    ...priceEvidence,
                ],
                warnings: priceWarnings,
            }),
            totalIncome: createCalculationTrace({
                namespace: 'dashboard-kpi',
                identity: { bookGuid, metric: 'income', dateRange },
                title: 'Total income',
                summary: 'Income-account splits in the selected period, converted to the book currency.',
                asOfDate: endDate.toISOString().slice(0, 10),
                formula: 'sum(-income account split values × exchange rate)',
                result: summary.totalIncome,
                unit: 'currency',
                evidence: commonEvidence,
            }),
            totalExpenses: createCalculationTrace({
                namespace: 'dashboard-kpi',
                identity: { bookGuid, metric: 'expenses', dateRange },
                title: 'Total expenses',
                summary: 'Expense-account splits in the selected period, converted to the book currency.',
                asOfDate: endDate.toISOString().slice(0, 10),
                formula: 'sum(expense account split values × exchange rate)',
                result: summary.totalExpenses,
                unit: 'currency',
                steps: [{
                    key: 'top-category',
                    label: 'Largest top-level expense category',
                    inputs: { category: summary.topExpenseCategory || 'None' },
                    result: summary.topExpenseAmount,
                }],
                evidence: commonEvidence,
            }),
            savingsRate: createCalculationTrace({
                namespace: 'dashboard-kpi',
                identity: { bookGuid, metric: 'savings-rate', dateRange },
                title: 'Savings rate',
                summary: 'The share of income left after expenses during the selected period.',
                asOfDate: endDate.toISOString().slice(0, 10),
                formula: '(income − expenses) ÷ income × 100',
                result: summary.savingsRate,
                unit: 'percent',
                steps: [{
                    key: 'savings-rate',
                    label: 'Calculate savings rate',
                    formula: '(income - expenses) / income * 100',
                    inputs: {
                        income: summary.totalIncome,
                        expenses: summary.totalExpenses,
                    },
                    result: summary.savingsRate,
                }],
                evidence: commonEvidence,
                warnings: summary.totalIncome <= 0
                    ? ['Savings rate is shown as 0% when income is zero or negative.']
                    : [],
            }),
            investmentValue: createCalculationTrace({
                namespace: 'dashboard-kpi',
                identity: { bookGuid, metric: 'investment-value', dateRange },
                title: 'Investment value',
                summary: 'Security quantities multiplied by the latest positive market price on or before the selected date.',
                asOfDate: endDate.toISOString().slice(0, 10),
                formula: 'sum(security quantity × latest price)',
                result: summary.investmentValue,
                unit: 'currency',
                evidence: [
                    ...commonEvidence,
                    ...priceEvidence,
                ],
                warnings: priceWarnings,
            }),
        };
        await persistCalculationTraces(roleResult.user.id, bookGuid, Object.values(traces));

        const responseData = {
            ...summary,
            traces: Object.fromEntries(
                Object.entries(traces).map(([key, trace]) => [
                    key,
                    { traceId: trace.id, href: `/api/provenance/${trace.id}` },
                ]),
            ),
        };

        // Cache the result (24 hour TTL)
        await cacheSet(cacheKey, responseData, 86400);

        return NextResponse.json(responseData);
    } catch (error) {
        console.error('Error fetching KPI data:', error);
        return NextResponse.json(
            { error: 'Failed to fetch KPI data' },
            { status: 500 }
        );
    }
}
