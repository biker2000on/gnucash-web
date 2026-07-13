import prisma from '@/lib/prisma';
import { getBaseCurrency } from '@/lib/currency';

/**
 * FX Revaluation report.
 *
 * For each foreign (non-base) currency the book holds cash in, this report
 * computes the currency exposure and the FX gain/loss embedded in it.
 *
 * ── Model ────────────────────────────────────────────────────────────────
 * "Foreign currency holdings" are the balances of non-TRADING accounts whose
 * commodity is a CURRENCY other than the book's base currency (the root
 * account's commodity). Trading accounts (Trading:CURRENCY:XXX — see
 * src/lib/trading-accounts.ts) are GnuCash's balancing entries for
 * multi-currency transactions; including them would double-count every flow,
 * so they are excluded.
 *
 * Average acquisition rate uses the MOVING-AVERAGE method over the account's
 * split history in chronological order:
 *   - A split's `value` is denominated in its transaction's currency. When
 *     that currency is the base currency, value/quantity IS the exchange
 *     rate realized on that flow. Only such splits carry rate information.
 *   - Acquisitions (quantity > 0) add quantity and base-currency cost;
 *     avg rate = total cost / total quantity.
 *   - Disposals (quantity < 0) remove cost at the current average rate and
 *     realize gain/loss = proceeds(base) − quantity_sold × avg_rate.
 *   - Splits whose transaction currency is NOT the base currency (e.g. a
 *     EUR→GBP transfer booked in EUR) carry no base value. They are carried
 *     at the prevailing average rate when one exists, and their quantity is
 *     accumulated into the honest `otherQuantity` bucket so the user can see
 *     how much of the position was estimated rather than priced. Disposals
 *     without a base value realize nothing (their eventual gain shows up as
 *     unrealized drift instead).
 *
 * Unrealized FX gain/loss = current quantity × (current rate − avg rate),
 * where the current rate is the latest `prices` row commodity→base (or the
 * inverse base→commodity as a fallback).
 *
 * Realized FX gain/loss is reported for a user-selected period by summing
 * the realized events whose post date falls inside it. This is derived from
 * cash-account activity, NOT from trading-account balances — trading account
 * rows only mirror the same flows and carry no cost-basis information.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FxFlowRow {
    /** Foreign currency mnemonic (e.g. 'EUR'). */
    currency: string;
    /** Transaction post date. */
    postDate: Date | string;
    /** Signed foreign-currency amount of the split. */
    quantity: number;
    /**
     * Signed base-currency value of the split, or null when the transaction
     * currency was not the base currency (no base valuation available).
     */
    baseValue: number | null;
}

export interface FxRealizedEvent {
    currency: string;
    date: string; // ISO YYYY-MM-DD
    quantitySold: number;
    proceeds: number;
    costBasis: number;
    gainLoss: number;
}

export interface FxCurrencyPosition {
    currency: string;
    /** Current foreign cash balance. */
    quantity: number;
    /** Remaining base-currency cost basis of the balance. */
    baseCost: number;
    /** Weighted average acquisition rate (base per unit), or null. */
    avgRate: number | null;
    /** Latest known market rate (base per unit), or null when unpriced. */
    currentRate: number | null;
    currentRateDate: string | null;
    /** Balance valued at the current rate, or null when unpriced. */
    currentValue: number | null;
    /** quantity × (currentRate − avgRate), or null when either rate is unknown. */
    unrealizedGainLoss: number | null;
    /** Realized FX gain/loss inside the requested period. */
    realizedGainLoss: number;
    /** Realized FX gain/loss across all history. */
    realizedAllTime: number;
    /**
     * Net foreign quantity that moved WITHOUT a base-currency valuation
     * (cross-currency transactions). Non-zero means avg rate is partly
     * estimated — the honest "other" bucket.
     */
    otherQuantity: number;
}

export interface FxRevaluationData {
    title: string;
    generatedAt: string;
    baseCurrency: string;
    periodStart: string;
    periodEnd: string;
    hasForeignCurrency: boolean;
    positions: FxCurrencyPosition[];
    totals: {
        unrealizedGainLoss: number;
        realizedGainLoss: number;
        currentValue: number;
    };
}

export interface CurrentRate {
    rate: number;
    date: Date | string | null;
}

const EPSILON = 1e-9;

function isoDate(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
    }
    return String(value).slice(0, 10) || null;
}

// ---------------------------------------------------------------------------
// Pure core (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Compute per-currency FX positions from chronological flow rows.
 * `rows` need not be pre-sorted; they are sorted per currency by date here.
 */
export function computeFxPositions(
    rows: FxFlowRow[],
    currentRates: Record<string, CurrentRate | undefined>,
    periodStart: string,
    periodEnd: string,
): { positions: FxCurrencyPosition[]; realizedEvents: FxRealizedEvent[] } {
    const byCurrency = new Map<string, FxFlowRow[]>();
    for (const row of rows) {
        const list = byCurrency.get(row.currency) ?? [];
        list.push(row);
        byCurrency.set(row.currency, list);
    }

    const positions: FxCurrencyPosition[] = [];
    const allEvents: FxRealizedEvent[] = [];

    for (const [currency, flowRows] of byCurrency) {
        const sorted = [...flowRows].sort((a, b) => {
            const ta = new Date(a.postDate).getTime();
            const tb = new Date(b.postDate).getTime();
            return ta - tb;
        });

        let qty = 0;
        let cost = 0;
        let otherQuantity = 0;
        // False until at least one acquisition carried a base-currency value —
        // an entirely unvalued position has NO average rate (not a rate of 0).
        let hasCostBasis = false;
        const events: FxRealizedEvent[] = [];

        for (const row of sorted) {
            const q = row.quantity;
            if (Math.abs(q) < EPSILON) continue; // value-only bookkeeping splits

            const avgBefore = qty > EPSILON && hasCostBasis ? cost / qty : null;

            if (q > 0) {
                // Acquisition
                if (row.baseValue !== null) {
                    qty += q;
                    cost += row.baseValue;
                    hasCostBasis = true;
                } else {
                    // Cross-currency inflow: carry at prevailing average (if any)
                    qty += q;
                    if (avgBefore !== null) cost += q * avgBefore;
                    otherQuantity += q;
                }
            } else {
                // Disposal
                const sellQty = -q;
                const costRemoved = avgBefore !== null ? sellQty * avgBefore : 0;
                qty += q;
                cost -= costRemoved;
                if (qty <= EPSILON) {
                    qty = Math.max(qty, 0);
                    cost = 0;
                }

                if (row.baseValue !== null) {
                    const proceeds = -row.baseValue;
                    if (avgBefore !== null) {
                        events.push({
                            currency,
                            date: isoDate(row.postDate) ?? '',
                            quantitySold: sellQty,
                            proceeds,
                            costBasis: costRemoved,
                            gainLoss: proceeds - costRemoved,
                        });
                    } else {
                        otherQuantity += q;
                    }
                } else {
                    otherQuantity += q;
                }
            }
        }

        const avgRate = qty > EPSILON && hasCostBasis ? cost / qty : null;
        const current = currentRates[currency];
        const currentRate = current?.rate ?? null;
        const unrealizedGainLoss =
            avgRate !== null && currentRate !== null ? qty * (currentRate - avgRate) : null;

        const realizedAllTime = events.reduce((sum, e) => sum + e.gainLoss, 0);
        const realizedGainLoss = events
            .filter((e) => e.date >= periodStart && e.date <= periodEnd)
            .reduce((sum, e) => sum + e.gainLoss, 0);

        positions.push({
            currency,
            quantity: qty,
            baseCost: cost,
            avgRate,
            currentRate,
            currentRateDate: isoDate(current?.date ?? null),
            currentValue: currentRate !== null ? qty * currentRate : null,
            unrealizedGainLoss,
            realizedGainLoss,
            realizedAllTime,
            otherQuantity,
        });
        allEvents.push(...events);
    }

    positions.sort((a, b) => a.currency.localeCompare(b.currency));
    return { positions, realizedEvents: allEvents };
}

// ---------------------------------------------------------------------------
// Report generator (DB access)
// ---------------------------------------------------------------------------

export interface GenerateFxRevaluationParams {
    bookAccountGuids: string[];
    /** Period for REALIZED gains (YYYY-MM-DD, inclusive). */
    periodStart: string;
    periodEnd: string;
}

interface FlowQueryRow {
    account_guid: string;
    quantity: number | null;
    base_value: number | null;
    post_date: Date;
}

export async function generateFxRevaluation(
    params: GenerateFxRevaluationParams,
): Promise<FxRevaluationData> {
    const { bookAccountGuids, periodStart, periodEnd } = params;

    const base = await getBaseCurrency();
    if (!base) throw new Error('No base currency available');

    const emptyResult = (): FxRevaluationData => ({
        title: 'FX Revaluation',
        generatedAt: new Date().toISOString(),
        baseCurrency: base.mnemonic,
        periodStart,
        periodEnd,
        hasForeignCurrency: false,
        positions: [],
        totals: { unrealizedGainLoss: 0, realizedGainLoss: 0, currentValue: 0 },
    });

    if (bookAccountGuids.length === 0) return emptyResult();

    // Foreign-currency cash accounts (exclude TRADING/ROOT bookkeeping accounts)
    const foreignAccounts = await prisma.accounts.findMany({
        where: {
            guid: { in: bookAccountGuids },
            account_type: { notIn: ['TRADING', 'ROOT'] },
            commodity: {
                namespace: 'CURRENCY',
                mnemonic: { not: base.mnemonic },
            },
        },
        select: {
            guid: true,
            commodity: { select: { guid: true, mnemonic: true } },
        },
    });

    if (foreignAccounts.length === 0) return emptyResult();

    const accountCurrency = new Map<string, string>();
    const commodityGuids = new Set<string>();
    for (const account of foreignAccounts) {
        if (!account.commodity) continue;
        accountCurrency.set(account.guid, account.commodity.mnemonic);
        commodityGuids.add(account.commodity.guid);
    }
    const foreignGuids = [...accountCurrency.keys()];

    // Flow history: base value only when the transaction is base-denominated
    const flowRows = await prisma.$queryRaw<FlowQueryRow[]>`
        SELECT s.account_guid,
               (s.quantity_num::numeric / NULLIF(s.quantity_denom, 0)::numeric)::float8 AS quantity,
               CASE WHEN t.currency_guid = ${base.guid}
                    THEN (s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric)::float8
                    ELSE NULL END AS base_value,
               t.post_date
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE s.account_guid = ANY(${foreignGuids})
        ORDER BY t.post_date ASC, s.guid ASC
    `;

    const rows: FxFlowRow[] = flowRows
        .filter((r) => accountCurrency.has(r.account_guid))
        .map((r) => ({
            currency: accountCurrency.get(r.account_guid)!,
            postDate: r.post_date,
            quantity: Number(r.quantity ?? 0),
            baseValue: r.base_value === null ? null : Number(r.base_value),
        }));

    // Latest market rate per currency: direct commodity→base, inverse fallback
    const commodityGuidList = [...commodityGuids];
    const [directPrices, inversePrices] = await Promise.all([
        prisma.prices.findMany({
            where: { commodity_guid: { in: commodityGuidList }, currency_guid: base.guid },
            orderBy: { date: 'desc' },
            select: { commodity_guid: true, date: true, value_num: true, value_denom: true },
        }),
        prisma.prices.findMany({
            where: { commodity_guid: base.guid, currency_guid: { in: commodityGuidList } },
            orderBy: { date: 'desc' },
            select: { currency_guid: true, date: true, value_num: true, value_denom: true },
        }),
    ]);

    const guidToMnemonic = new Map<string, string>();
    for (const account of foreignAccounts) {
        if (account.commodity) guidToMnemonic.set(account.commodity.guid, account.commodity.mnemonic);
    }

    const currentRates: Record<string, CurrentRate> = {};
    for (const price of directPrices) {
        const mnemonic = guidToMnemonic.get(price.commodity_guid);
        if (!mnemonic || currentRates[mnemonic]) continue; // rows are date-desc; keep latest
        const denom = Number(price.value_denom);
        if (denom === 0) continue;
        currentRates[mnemonic] = { rate: Number(price.value_num) / denom, date: price.date };
    }
    for (const price of inversePrices) {
        const mnemonic = guidToMnemonic.get(price.currency_guid);
        if (!mnemonic || currentRates[mnemonic]) continue;
        const value = Number(price.value_num) / Number(price.value_denom);
        if (!Number.isFinite(value) || value === 0) continue;
        currentRates[mnemonic] = { rate: 1 / value, date: price.date };
    }

    const { positions } = computeFxPositions(rows, currentRates, periodStart, periodEnd);

    const totals = positions.reduce(
        (acc, p) => ({
            unrealizedGainLoss: acc.unrealizedGainLoss + (p.unrealizedGainLoss ?? 0),
            realizedGainLoss: acc.realizedGainLoss + p.realizedGainLoss,
            currentValue: acc.currentValue + (p.currentValue ?? 0),
        }),
        { unrealizedGainLoss: 0, realizedGainLoss: 0, currentValue: 0 },
    );

    return {
        title: 'FX Revaluation',
        generatedAt: new Date().toISOString(),
        baseCurrency: base.mnemonic,
        periodStart,
        periodEnd,
        hasForeignCurrency: true,
        positions,
        totals,
    };
}
