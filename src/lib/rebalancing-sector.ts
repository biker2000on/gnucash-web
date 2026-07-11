/**
 * Sector-Based Rebalancing
 *
 * Pure functions that let the generic rebalancing engine
 * (src/lib/rebalancing.ts) operate on SECTOR allocations instead of
 * per-symbol allocations:
 *
 *  1. holdingsToSectorExposure — maps symbol-keyed holdings to
 *     sector-keyed holdings using cached commodity metadata
 *     (gnucash_web_commodity_metadata: `sector` for single stocks,
 *     `sector_weights` JSONB for funds/ETFs).
 *  2. mapSectorSuggestionsToSymbolTrades — you cannot "buy the
 *     Technology sector" directly, so each sector-level BUY/SELL is
 *     spread across the symbols that expose that sector,
 *     proportionally to each symbol's dollar contribution.
 *  3. parseRebalanceConfig — reads the saved tool-config shape,
 *     migrating the legacy `{ targets, bandPct }` shape (symbol mode)
 *     to the current `{ mode, targetsBySymbol, targetsBySector,
 *     bandPct }` shape.
 *
 * Rounding: per-symbol trade slices are rounded to cents individually;
 * the residual cent(s) versus the sector amount are assigned to the
 * largest contributor so slices always sum exactly to the sector trade.
 */

import {
    DEFAULT_BAND_PCT,
    type RebalanceHolding,
    type RebalanceSuggestion,
    type RebalanceTarget,
} from './rebalancing';

export const UNCLASSIFIED_SECTOR = 'Unclassified';

const EPS = 1e-9;

function round2(v: number): number {
    return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------------------
// Sector exposure
// ---------------------------------------------------------------------------

/** Minimal metadata needed to classify one symbol, keyed by symbol. */
export interface SectorMetadataEntry {
    /** Single-stock sector (assetProfile.sector), when known. */
    sector: string | null;
    /**
     * Fund/ETF sector weights as PERCENTAGES (0-100), e.g.
     * { Technology: 28.4, Healthcare: 12.1, ... }.
     */
    sectorWeights: Record<string, number> | null;
}

/** One symbol's dollar contribution to a sector. */
export interface SectorContribution {
    symbol: string;
    label: string;
    /** Dollars of this symbol's market value attributed to the sector. */
    value: number;
}

export interface SectorExposureResult {
    /** Sector-keyed holdings, ready for computeRebalance. */
    holdings: RebalanceHolding[];
    /** sector -> contributing symbols, sorted by value desc. */
    contributions: Record<string, SectorContribution[]>;
    /**
     * Symbols with NO usable sector data at all (their full value went
     * to 'Unclassified'). Symbols with partial fund weights are not
     * listed here.
     */
    unclassifiedSymbols: string[];
}

/**
 * Spread symbol-keyed holdings into sector-keyed holdings.
 *
 * - Fund/ETF with sector_weights: value is distributed as
 *   value * weight/100 per sector. If weights sum to more than 100
 *   they are scaled down proportionally; if they sum to less than 100
 *   the uncovered remainder goes to 'Unclassified' (funds often hold
 *   bonds/cash that Yahoo's equity sector weights do not cover).
 * - Single stock with a sector: 100% of value to that sector.
 * - No metadata (or empty): 100% to 'Unclassified' and the symbol is
 *   reported in `unclassifiedSymbols`.
 */
export function holdingsToSectorExposure(
    holdings: RebalanceHolding[],
    metadata: Record<string, SectorMetadataEntry | undefined>
): SectorExposureResult {
    const sectorTotals = new Map<string, number>();
    const contributions: Record<string, SectorContribution[]> = {};
    const unclassifiedSymbols: string[] = [];

    const addContribution = (sector: string, symbol: string, label: string, value: number) => {
        if (value <= EPS) return;
        sectorTotals.set(sector, (sectorTotals.get(sector) ?? 0) + value);
        (contributions[sector] ??= []).push({ symbol, label, value });
    };

    for (const h of holdings) {
        if (h.currentValue <= EPS) continue;
        const meta = metadata[h.key];

        const weights = meta?.sectorWeights
            ? Object.entries(meta.sectorWeights).filter(([, w]) => typeof w === 'number' && w > EPS)
            : [];
        const weightSum = weights.reduce((s, [, w]) => s + w, 0);

        if (weightSum > EPS) {
            // Fund/ETF: distribute across sectors. Scale down if > 100.
            const scale = weightSum > 100 ? 100 / weightSum : 1;
            let covered = 0;
            for (const [sector, weight] of weights) {
                const value = h.currentValue * ((weight * scale) / 100);
                covered += value;
                addContribution(sector, h.key, h.label, value);
            }
            const remainder = h.currentValue - covered;
            if (remainder > 0.005) {
                addContribution(UNCLASSIFIED_SECTOR, h.key, h.label, remainder);
            }
        } else if (meta?.sector) {
            // Single stock: 100% to its sector.
            addContribution(meta.sector, h.key, h.label, h.currentValue);
        } else {
            // No usable sector data.
            addContribution(UNCLASSIFIED_SECTOR, h.key, h.label, h.currentValue);
            unclassifiedSymbols.push(h.key);
        }
    }

    const sectorHoldings: RebalanceHolding[] = [...sectorTotals.entries()]
        .map(([sector, value]) => ({
            key: sector,
            label: sector,
            currentValue: round2(value),
        }))
        .sort((a, b) => b.currentValue - a.currentValue || a.key.localeCompare(b.key));

    for (const list of Object.values(contributions)) {
        list.sort((a, b) => b.value - a.value || a.symbol.localeCompare(b.symbol));
    }

    return {
        holdings: sectorHoldings,
        contributions,
        unclassifiedSymbols: unclassifiedSymbols.sort(),
    };
}

// ---------------------------------------------------------------------------
// Sector suggestion -> per-symbol trades
// ---------------------------------------------------------------------------

/** A per-symbol slice of a sector-level trade. */
export interface SectorSymbolTrade {
    symbol: string;
    label: string;
    /** Positive dollars for this symbol's slice of the sector trade. */
    amount: number;
    /** Fraction (0-1) of the sector's exposure this symbol provides. */
    shareOfSector: number;
}

/** A sector-level suggestion with its per-symbol trade breakdown. */
export interface SectorSuggestionGroup {
    sector: string;
    action: 'BUY' | 'SELL';
    amount: number;
    outsideBand: boolean;
    trades: SectorSymbolTrade[];
}

export interface SectorTradeMapping {
    bySector: SectorSuggestionGroup[];
    /**
     * Net per-symbol suggestions: a symbol appearing in several sector
     * trades (a fund spans sectors) is netted (buys minus sells) into
     * one BUY or SELL row. This is the list to tax-annotate.
     */
    netBySymbol: RebalanceSuggestion[];
}

const MIN_TRADE = 0.01;

/**
 * Map sector-keyed rebalance suggestions to per-symbol trades.
 *
 * Each sector's amount is split across contributing symbols
 * proportionally to their dollar contribution to that sector.
 * Rounding: slices are rounded to cents; the residual versus the
 * sector amount is assigned to the largest slice so slices sum exactly
 * to the sector amount. Sectors with no contributing holdings (e.g. a
 * target on an unheld sector) produce a group with an empty trades
 * list.
 */
export function mapSectorSuggestionsToSymbolTrades(
    suggestions: RebalanceSuggestion[],
    contributions: Record<string, SectorContribution[]>
): SectorTradeMapping {
    const bySector: SectorSuggestionGroup[] = [];
    // symbol -> signed net (+ buy, - sell) and label
    const net = new Map<string, { label: string; signed: number; outsideBand: boolean }>();

    for (const s of suggestions) {
        const contribs = contributions[s.key] ?? [];
        const total = contribs.reduce((sum, c) => sum + c.value, 0);

        const trades: SectorSymbolTrade[] = [];
        if (total > EPS) {
            // Proportional slices, rounded to cents.
            let allocated = 0;
            let largestIdx = -1;
            let largestValue = -1;
            for (const c of contribs) {
                const raw = s.amount * (c.value / total);
                const amount = round2(raw);
                if (c.value > largestValue) {
                    largestValue = c.value;
                    largestIdx = trades.length;
                }
                trades.push({
                    symbol: c.symbol,
                    label: c.label,
                    amount,
                    shareOfSector: Math.round((c.value / total) * 10000) / 10000,
                });
                allocated += amount;
            }
            // Assign the rounding residual to the largest contributor.
            const residual = round2(s.amount - allocated);
            if (Math.abs(residual) >= 0.005 && largestIdx >= 0) {
                trades[largestIdx].amount = round2(trades[largestIdx].amount + residual);
            }
        }

        const kept = trades.filter(t => t.amount >= MIN_TRADE);
        bySector.push({
            sector: s.key,
            action: s.action,
            amount: s.amount,
            outsideBand: s.outsideBand,
            trades: kept,
        });

        const sign = s.action === 'BUY' ? 1 : -1;
        for (const t of kept) {
            const entry = net.get(t.symbol) ?? { label: t.label, signed: 0, outsideBand: false };
            entry.signed += sign * t.amount;
            entry.outsideBand = entry.outsideBand || s.outsideBand;
            net.set(t.symbol, entry);
        }
    }

    const netBySymbol: RebalanceSuggestion[] = [];
    for (const [symbol, entry] of net) {
        const amount = round2(Math.abs(entry.signed));
        if (amount < MIN_TRADE) continue;
        netBySymbol.push({
            action: entry.signed > 0 ? 'BUY' : 'SELL',
            key: symbol,
            label: entry.label,
            amount,
            outsideBand: entry.outsideBand,
        });
    }
    // Sells first (they fund the buys), largest amounts first within group
    netBySymbol.sort((a, b) => {
        if (a.action !== b.action) return a.action === 'SELL' ? -1 : 1;
        return b.amount - a.amount;
    });

    return { bySector, netBySymbol };
}

// ---------------------------------------------------------------------------
// Saved config (tool-config `rebalance_targets`) parsing + migration
// ---------------------------------------------------------------------------

export type RebalanceMode = 'symbol' | 'sector';

export interface RebalanceConfig {
    mode: RebalanceMode;
    targetsBySymbol: RebalanceTarget[];
    targetsBySector: RebalanceTarget[];
    bandPct: number;
}

function parseTargetList(value: unknown): RebalanceTarget[] {
    const targets: RebalanceTarget[] = [];
    if (!Array.isArray(value)) return targets;
    for (const t of value) {
        if (
            t && typeof t === 'object' &&
            typeof (t as Record<string, unknown>).key === 'string' &&
            typeof (t as Record<string, unknown>).targetPct === 'number' &&
            Number.isFinite((t as { targetPct: number }).targetPct)
        ) {
            targets.push({
                key: (t as { key: string }).key,
                targetPct: (t as { targetPct: number }).targetPct,
            });
        }
    }
    return targets;
}

/**
 * Parse the saved rebalance tool-config.
 *
 * Migration: the legacy shape `{ targets: [...], bandPct }` (written
 * before sector mode existed) is read as
 * `{ mode: 'symbol', targetsBySymbol: targets, targetsBySector: [] }`.
 * The current shape is
 * `{ mode, targetsBySymbol, targetsBySector, bandPct }`; writes always
 * use the current shape.
 */
export function parseRebalanceConfig(config: unknown): RebalanceConfig {
    const fallback: RebalanceConfig = {
        mode: 'symbol',
        targetsBySymbol: [],
        targetsBySector: [],
        bandPct: DEFAULT_BAND_PCT,
    };
    if (!config || typeof config !== 'object') return fallback;
    const obj = config as Record<string, unknown>;

    const mode: RebalanceMode = obj.mode === 'sector' ? 'sector' : 'symbol';

    // Current shape first; legacy `targets` array acts as targetsBySymbol.
    const targetsBySymbol = 'targetsBySymbol' in obj
        ? parseTargetList(obj.targetsBySymbol)
        : parseTargetList(obj.targets);
    const targetsBySector = parseTargetList(obj.targetsBySector);

    const bandPct = typeof obj.bandPct === 'number' && obj.bandPct >= 0
        ? obj.bandPct
        : DEFAULT_BAND_PCT;

    return { mode, targetsBySymbol, targetsBySector, bandPct };
}
