/**
 * Portfolio Rebalancing Engine
 *
 * Pure functions for computing allocation drift and rebalancing
 * suggestions, plus a DB loader that gathers open-lot sell candidates
 * (via src/lib/lots.ts) for tax-aware sell ordering.
 *
 * Keying: targets are keyed by commodity SYMBOL (mnemonic). The
 * commodity metadata table's asset_class is auto-derived from Yahoo
 * ('stock'/'etf') and too coarse to serve as an allocation category,
 * so per-symbol targets are used instead.
 *
 * Band semantics: the tolerance band is ABSOLUTE percentage points
 * (default 5). A key is outside the band when
 * |currentPct - targetPct| > bandPct. Example: target 20%, band 5
 * means acceptable range is 15%..25% of portfolio value.
 *
 * Full-rebalance suggestions trade ONLY out-of-band holdings back to
 * target (threshold rebalancing); in-band drift is tolerated by design.
 * Buy-only mode (newCash > 0) allocates cash to all underweights.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RebalanceHolding {
    /** Allocation key (commodity symbol). */
    key: string;
    /** Display label (full name or symbol). */
    label: string;
    /** Current market value in report currency. */
    currentValue: number;
}

export interface RebalanceTarget {
    key: string;
    /** Target percent of portfolio (0-100). */
    targetPct: number;
}

export interface RebalanceRow {
    key: string;
    label: string;
    currentValue: number;
    /** Percent of current portfolio value (0-100). */
    currentPct: number;
    /** Normalized target percent (0-100, sums to 100 across rows when targets exist). */
    targetPct: number;
    /** Target percent exactly as saved (before normalization). */
    rawTargetPct: number;
    /** currentPct - targetPct, in absolute percentage points. */
    driftPct: number;
    /** Dollar value this key should hold at target. */
    targetValue: number;
    /** Dollars to reach target: targetValue - currentValue (+ = buy, - = sell). */
    delta: number;
    /** True when |driftPct| > bandPct. */
    outsideBand: boolean;
    /** True when the key has a target but no current holding. */
    missingHolding: boolean;
    /** True when the key is held but has no explicit target (treated as 0%). */
    missingTarget: boolean;
}

export type HoldingTerm = 'short_term' | 'long_term' | null;

/** An open lot that could be (partially) sold. */
export interface SellLotCandidate {
    lotGuid: string;
    accountGuid: string;
    accountName?: string;
    title: string;
    /** Current market value of the remaining shares in the lot. */
    marketValue: number;
    /** Unrealized gain (negative = loss) on the remaining shares. */
    unrealizedGain: number;
    term: HoldingTerm;
}

/** A slice of a lot consumed by a sell suggestion. */
export interface LotConsumption {
    lotGuid: string;
    title: string;
    accountGuid: string;
    accountName?: string;
    sellValue: number;
    /** Estimated realized gain for the sold portion (negative = harvested loss). */
    estimatedGain: number;
    term: HoldingTerm;
}

export interface SellTaxAnnotation {
    /** Total estimated realized gain across consumed lots (negative = net loss). */
    estimatedGain: number;
    shortTermGain: number;
    longTermGain: number;
    /** Estimated harvested losses (sum of negative-gain slices, as a negative number). */
    harvestedLoss: number;
    lots: LotConsumption[];
    /** Fraction of the sell amount covered by known lots (0-1). */
    coverage: number;
}

export interface RebalanceSuggestion {
    action: 'BUY' | 'SELL';
    key: string;
    label: string;
    /** Positive dollar amount to buy or sell. */
    amount: number;
    /**
     * Always true in full-rebalance mode (in-band holdings are not traded);
     * in buy-only mode, cash may flow to in-band underweights too.
     */
    outsideBand: boolean;
    /** Present on SELL suggestions after tax annotation. */
    tax?: SellTaxAnnotation;
}

export interface RebalanceResult {
    totalValue: number;
    /** totalValue + newCash: the portfolio value the targets are computed against. */
    targetBase: number;
    newCash: number;
    bandPct: number;
    mode: 'buy-only' | 'full';
    rows: RebalanceRow[];
    suggestions: RebalanceSuggestion[];
    warnings: string[];
}

export interface RebalanceOptions {
    /** New cash to invest (>= 0). When > 0, buy-only suggestions are produced. */
    newCash?: number;
    /** Tolerance band in absolute percentage points. Default 5. */
    bandPct?: number;
}

export const DEFAULT_BAND_PCT = 5;

/** Ignore trades below this many dollars. */
const MIN_TRADE = 0.01;
const EPS = 1e-9;

function round2(v: number): number {
    return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------------------
// Core engine
// ---------------------------------------------------------------------------

/**
 * Compute drift rows and rebalancing suggestions.
 *
 * - Targets that do not sum to 100 are normalized (scaled so they sum
 *   to 100) and a warning is emitted.
 * - Holdings with no target are treated as 0% target (warning).
 * - Targets with no matching holding produce a row with zero current
 *   value (warning).
 * - With newCash > 0, suggestions are buy-only: cash is allocated to
 *   underweight keys proportionally to their dollar shortfall
 *   ("cash-flow rebalancing"). If cash exceeds the total shortfall,
 *   the excess is spread across targeted keys proportionally to their
 *   target percent.
 * - With newCash = 0, a full rebalance is suggested: sell overweights /
 *   buy underweights so every key lands exactly on target (net ~$0).
 */
export function computeRebalance(
    holdings: RebalanceHolding[],
    targets: RebalanceTarget[],
    options: RebalanceOptions = {}
): RebalanceResult {
    const warnings: string[] = [];
    const newCash = Math.max(0, options.newCash ?? 0);
    const bandPct = options.bandPct !== undefined && options.bandPct >= 0
        ? options.bandPct
        : DEFAULT_BAND_PCT;

    const totalValue = holdings.reduce((sum, h) => sum + h.currentValue, 0);
    const targetBase = totalValue + newCash;

    // Deduplicate targets by key (last wins) and index them
    const targetMap = new Map<string, number>();
    for (const t of targets) {
        targetMap.set(t.key, t.targetPct);
    }

    const rawTargetSum = Array.from(targetMap.values()).reduce((s, v) => s + v, 0);
    const hasTargets = targetMap.size > 0 && rawTargetSum > EPS;

    if (targetMap.size > 0 && rawTargetSum <= EPS) {
        warnings.push('Targets sum to 0% — no rebalancing suggestions can be computed.');
    } else if (hasTargets && Math.abs(rawTargetSum - 100) > 0.01) {
        warnings.push(
            `Targets sum to ${round2(rawTargetSum)}% (not 100%) — normalized proportionally.`
        );
    }
    if (targetMap.size === 0) {
        warnings.push('No target allocation defined.');
    }

    // Normalization factor so effective targets sum to 100
    const normFactor = hasTargets ? 100 / rawTargetSum : 0;

    // Union of keys: all holdings + all targets
    const holdingMap = new Map<string, RebalanceHolding>();
    for (const h of holdings) {
        const existing = holdingMap.get(h.key);
        if (existing) {
            existing.currentValue += h.currentValue;
        } else {
            holdingMap.set(h.key, { ...h });
        }
    }

    const allKeys = new Set<string>([...holdingMap.keys(), ...targetMap.keys()]);

    const untargetedHeld: string[] = [];
    const unheldTargets: string[] = [];

    const rows: RebalanceRow[] = [];
    for (const key of allKeys) {
        const holding = holdingMap.get(key);
        const rawTargetPct = targetMap.get(key);

        const currentValue = holding?.currentValue ?? 0;
        const currentPct = totalValue > EPS ? (currentValue / totalValue) * 100 : 0;
        const targetPct = rawTargetPct !== undefined ? rawTargetPct * normFactor : 0;
        const targetValue = (targetPct / 100) * targetBase;
        const delta = targetValue - currentValue;
        const driftPct = currentPct - targetPct;

        const missingHolding = !holding && rawTargetPct !== undefined && rawTargetPct > EPS;
        const missingTarget = !!holding && rawTargetPct === undefined;

        if (missingHolding) unheldTargets.push(key);
        if (missingTarget) untargetedHeld.push(key);

        rows.push({
            key,
            label: holding?.label ?? key,
            currentValue: round2(currentValue),
            currentPct: round2(currentPct),
            targetPct: round2(targetPct),
            rawTargetPct: rawTargetPct ?? 0,
            driftPct: round2(driftPct),
            targetValue: round2(targetValue),
            delta: round2(delta),
            outsideBand: Math.abs(driftPct) > bandPct + EPS,
            missingHolding,
            missingTarget,
        });
    }

    if (untargetedHeld.length > 0) {
        warnings.push(
            `Holdings without a target (treated as 0%): ${untargetedHeld.sort().join(', ')}`
        );
    }
    if (unheldTargets.length > 0) {
        warnings.push(
            `Targets with no current holding: ${unheldTargets.sort().join(', ')}`
        );
    }

    // Sort rows: largest current value first, then targets-without-holdings
    rows.sort((a, b) => b.currentValue - a.currentValue || a.key.localeCompare(b.key));

    // -----------------------------------------------------------------------
    // Suggestions
    // -----------------------------------------------------------------------
    const suggestions: RebalanceSuggestion[] = [];
    const mode: 'buy-only' | 'full' = newCash > 0 ? 'buy-only' : 'full';

    if (hasTargets) {
        if (mode === 'buy-only') {
            // Cash-flow rebalancing: allocate new cash to underweights
            // proportionally to their dollar shortfall.
            const shortfalls = rows
                .map(r => ({ row: r, shortfall: Math.max(0, r.targetValue - r.currentValue) }))
                .filter(s => s.shortfall > MIN_TRADE);
            const totalShortfall = shortfalls.reduce((s, x) => s + x.shortfall, 0);

            const allocations = new Map<string, number>();
            if (totalShortfall > EPS) {
                const usable = Math.min(newCash, totalShortfall);
                for (const s of shortfalls) {
                    allocations.set(s.row.key, usable * (s.shortfall / totalShortfall));
                }
            }

            // Leftover cash (targets already met): spread proportionally to target %
            const leftover = newCash - Math.min(newCash, totalShortfall);
            if (leftover > MIN_TRADE) {
                warnings.push(
                    'New cash exceeds the total shortfall — excess allocated proportionally to targets.'
                );
                const targetedRows = rows.filter(r => r.targetPct > EPS);
                const pctSum = targetedRows.reduce((s, r) => s + r.targetPct, 0);
                for (const r of targetedRows) {
                    const extra = pctSum > EPS ? leftover * (r.targetPct / pctSum) : 0;
                    allocations.set(r.key, (allocations.get(r.key) ?? 0) + extra);
                }
            }

            for (const row of rows) {
                const amount = allocations.get(row.key) ?? 0;
                if (amount > MIN_TRADE) {
                    suggestions.push({
                        action: 'BUY',
                        key: row.key,
                        label: row.label,
                        amount: round2(amount),
                        outsideBand: row.outsideBand,
                    });
                }
            }
        } else {
            // Full rebalance: trade only holdings OUTSIDE the tolerance band
            // back to target. In-band drift is exactly what the band exists
            // to tolerate — trading it would churn taxes and fees for no
            // benefit. Sells and buys therefore may not net to zero; the
            // difference stays in (or comes from) cash, surfaced as a warning.
            const tradable = rows.filter(
                r => r.outsideBand && Math.abs(r.delta) > MIN_TRADE
            );
            for (const row of tradable) {
                suggestions.push({
                    action: row.delta > 0 ? 'BUY' : 'SELL',
                    key: row.key,
                    label: row.label,
                    amount: round2(Math.abs(row.delta)),
                    outsideBand: row.outsideBand,
                });
            }

            const sellTotal = tradable
                .filter(r => r.delta < 0)
                .reduce((s, r) => s + Math.abs(r.delta), 0);
            const buyTotal = tradable
                .filter(r => r.delta > 0)
                .reduce((s, r) => s + r.delta, 0);
            const net = sellTotal - buyTotal;
            if (suggestions.length > 0 && Math.abs(net) > MIN_TRADE) {
                warnings.push(
                    net > 0
                        ? `Only out-of-band holdings are traded: sells exceed buys by $${round2(net).toLocaleString('en-US')} — the remainder stays in cash.`
                        : `Only out-of-band holdings are traded: buys exceed sells by $${round2(-net).toLocaleString('en-US')} — fund the difference from cash.`
                );
            }
        }
    }

    // Sells first (they fund the buys), largest amounts first within group
    suggestions.sort((a, b) => {
        if (a.action !== b.action) return a.action === 'SELL' ? -1 : 1;
        return b.amount - a.amount;
    });

    return {
        totalValue: round2(totalValue),
        targetBase: round2(targetBase),
        newCash: round2(newCash),
        bandPct,
        mode,
        rows,
        suggestions,
        warnings,
    };
}

// ---------------------------------------------------------------------------
// Tax-aware sell ordering
// ---------------------------------------------------------------------------

/**
 * Order sell candidates for tax efficiency:
 *  1. Losses first (largest loss first) — harvesting opportunity
 *  2. Long-term gains (smallest gain first)
 *  3. Short-term gains last (smallest gain first)
 * Lots with unknown holding period and a gain are treated as short-term
 * (conservative).
 */
export function orderSellCandidates(lots: SellLotCandidate[]): SellLotCandidate[] {
    const rank = (lot: SellLotCandidate): number => {
        if (lot.unrealizedGain < 0) return 0;
        if (lot.term === 'long_term') return 1;
        return 2;
    };
    return [...lots].sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        // Within losses: biggest loss first; within gains: smallest gain first
        return a.unrealizedGain - b.unrealizedGain;
    });
}

/**
 * Annotate SELL suggestions with estimated realized gains by walking
 * tax-ordered lots until the sell amount is covered. Lots are consumed
 * pro-rata: selling part of a lot realizes the same fraction of its
 * unrealized gain.
 */
export function annotateSellSuggestions(
    suggestions: RebalanceSuggestion[],
    lotsByKey: Record<string, SellLotCandidate[]>
): RebalanceSuggestion[] {
    return suggestions.map(suggestion => {
        if (suggestion.action !== 'SELL') return suggestion;

        const candidates = orderSellCandidates(lotsByKey[suggestion.key] ?? [])
            .filter(l => l.marketValue > MIN_TRADE);

        let remaining = suggestion.amount;
        const consumed: LotConsumption[] = [];

        for (const lot of candidates) {
            if (remaining <= MIN_TRADE) break;
            const sellValue = Math.min(remaining, lot.marketValue);
            const fraction = lot.marketValue > EPS ? sellValue / lot.marketValue : 0;
            consumed.push({
                lotGuid: lot.lotGuid,
                title: lot.title,
                accountGuid: lot.accountGuid,
                accountName: lot.accountName,
                sellValue: round2(sellValue),
                estimatedGain: round2(lot.unrealizedGain * fraction),
                term: lot.term,
            });
            remaining -= sellValue;
        }

        const estimatedGain = consumed.reduce((s, c) => s + c.estimatedGain, 0);
        const shortTermGain = consumed
            .filter(c => c.estimatedGain > 0 && c.term !== 'long_term')
            .reduce((s, c) => s + c.estimatedGain, 0);
        const longTermGain = consumed
            .filter(c => c.estimatedGain > 0 && c.term === 'long_term')
            .reduce((s, c) => s + c.estimatedGain, 0);
        const harvestedLoss = consumed
            .filter(c => c.estimatedGain < 0)
            .reduce((s, c) => s + c.estimatedGain, 0);
        const covered = suggestion.amount - Math.max(0, remaining);

        const tax: SellTaxAnnotation = {
            estimatedGain: round2(estimatedGain),
            shortTermGain: round2(shortTermGain),
            longTermGain: round2(longTermGain),
            harvestedLoss: round2(harvestedLoss),
            lots: consumed,
            coverage: suggestion.amount > EPS
                ? Math.round((covered / suggestion.amount) * 1000) / 1000
                : 0,
        };

        return { ...suggestion, tax };
    });
}

// ---------------------------------------------------------------------------
// DB loader (server-only; lazily imports prisma-backed modules so the
// pure engine above stays importable in tests and client components)
// ---------------------------------------------------------------------------

/**
 * Load open-lot sell candidates for a set of symbols, keyed by symbol.
 *
 * @param accountsBySymbol - map of symbol -> stock/mutual account GUIDs
 *   (and optional names) holding that commodity.
 */
export async function loadSellCandidatesBySymbol(
    accountsBySymbol: Record<string, Array<{ guid: string; name?: string }>>
): Promise<Record<string, SellLotCandidate[]>> {
    const { getAccountLots } = await import('./lots');

    const result: Record<string, SellLotCandidate[]> = {};

    for (const [symbol, accounts] of Object.entries(accountsBySymbol)) {
        const candidates: SellLotCandidate[] = [];
        for (const account of accounts) {
            const lots = await getAccountLots(account.guid);
            for (const lot of lots) {
                if (lot.isClosed) continue;
                if (Math.abs(lot.totalShares) < 0.0001) continue;
                if (lot.currentPrice === null) continue;
                const marketValue = lot.currentPrice * lot.totalShares;
                if (marketValue <= MIN_TRADE) continue;
                candidates.push({
                    lotGuid: lot.guid,
                    accountGuid: account.guid,
                    accountName: account.name,
                    title: lot.title,
                    marketValue: round2(marketValue),
                    unrealizedGain: round2(lot.unrealizedGain ?? 0),
                    term: lot.holdingPeriod,
                });
            }
        }
        result[symbol] = candidates;
    }

    return result;
}
