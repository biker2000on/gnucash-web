import { describe, it, expect } from 'vitest';
import {
    computeRebalance,
    DEFAULT_BAND_PCT,
    type RebalanceHolding,
    type RebalanceSuggestion,
} from '@/lib/rebalancing';
import {
    holdingsToSectorExposure,
    mapSectorSuggestionsToSymbolTrades,
    parseRebalanceConfig,
    UNCLASSIFIED_SECTOR,
    type SectorMetadataEntry,
} from '@/lib/rebalancing-sector';

const holdings: RebalanceHolding[] = [
    { key: 'AAPL', label: 'Apple Inc', currentValue: 10_000 },
    { key: 'VTI', label: 'Vanguard Total Stock', currentValue: 50_000 },
    { key: 'MYSTERY', label: 'Mystery Fund', currentValue: 5_000 },
];

const metadata: Record<string, SectorMetadataEntry> = {
    AAPL: { sector: 'Technology', sectorWeights: null },
    VTI: {
        sector: null,
        sectorWeights: { Technology: 30, Healthcare: 20, Financials: 50 },
    },
    // MYSTERY intentionally missing
};

function sector(result: ReturnType<typeof holdingsToSectorExposure>, key: string) {
    const h = result.holdings.find(x => x.key === key);
    expect(h, `sector ${key} should exist`).toBeDefined();
    return h!;
}

describe('holdingsToSectorExposure', () => {
    it('sends a single stock 100% to its sector', () => {
        const result = holdingsToSectorExposure(
            [{ key: 'AAPL', label: 'Apple', currentValue: 1_000 }],
            metadata
        );
        expect(result.holdings).toHaveLength(1);
        expect(sector(result, 'Technology').currentValue).toBe(1_000);
        expect(result.unclassifiedSymbols).toEqual([]);
        expect(result.contributions['Technology']).toEqual([
            { symbol: 'AAPL', label: 'Apple', value: 1_000 },
        ]);
    });

    it('spreads a fund across sectors proportionally to sector_weights', () => {
        const result = holdingsToSectorExposure(
            [{ key: 'VTI', label: 'VTI', currentValue: 10_000 }],
            metadata
        );
        expect(sector(result, 'Technology').currentValue).toBeCloseTo(3_000, 2);
        expect(sector(result, 'Healthcare').currentValue).toBeCloseTo(2_000, 2);
        expect(sector(result, 'Financials').currentValue).toBeCloseTo(5_000, 2);
        // Weights sum to exactly 100 -> no Unclassified remainder
        expect(result.holdings.find(h => h.key === UNCLASSIFIED_SECTOR)).toBeUndefined();
        expect(result.unclassifiedSymbols).toEqual([]);
    });

    it('routes uncovered fund weight remainder to Unclassified without flagging the symbol', () => {
        const result = holdingsToSectorExposure(
            [{ key: 'FND', label: 'Fund', currentValue: 10_000 }],
            { FND: { sector: null, sectorWeights: { Technology: 60 } } }
        );
        expect(sector(result, 'Technology').currentValue).toBeCloseTo(6_000, 2);
        expect(sector(result, UNCLASSIFIED_SECTOR).currentValue).toBeCloseTo(4_000, 2);
        // Partial data is not "unclassified" — the symbol is known, just not fully covered
        expect(result.unclassifiedSymbols).toEqual([]);
    });

    it('scales down fund weights that sum above 100', () => {
        const result = holdingsToSectorExposure(
            [{ key: 'FND', label: 'Fund', currentValue: 10_000 }],
            { FND: { sector: null, sectorWeights: { A: 75, B: 75 } } }
        );
        expect(sector(result, 'A').currentValue).toBeCloseTo(5_000, 2);
        expect(sector(result, 'B').currentValue).toBeCloseTo(5_000, 2);
        const total = result.holdings.reduce((s, h) => s + h.currentValue, 0);
        expect(total).toBeCloseTo(10_000, 2);
    });

    it('sends unknown symbols fully to Unclassified and reports them', () => {
        const result = holdingsToSectorExposure(holdings, metadata);
        expect(result.unclassifiedSymbols).toEqual(['MYSTERY']);
        expect(sector(result, UNCLASSIFIED_SECTOR).currentValue).toBe(5_000);
        // Technology = AAPL 10k + VTI 30% of 50k = 25k
        expect(sector(result, 'Technology').currentValue).toBeCloseTo(25_000, 2);
    });

    it('conserves total value across the sector spread', () => {
        const result = holdingsToSectorExposure(holdings, metadata);
        const total = result.holdings.reduce((s, h) => s + h.currentValue, 0);
        expect(total).toBeCloseTo(65_000, 1);
    });

    it('sorts per-sector contributions by value descending', () => {
        const result = holdingsToSectorExposure(holdings, metadata);
        const tech = result.contributions['Technology'];
        expect(tech.map(c => c.symbol)).toEqual(['VTI', 'AAPL']); // 15k vs 10k
    });
});

describe('mapSectorSuggestionsToSymbolTrades', () => {
    const exposure = holdingsToSectorExposure(holdings, metadata);

    it('splits a sector trade proportionally to symbol contributions', () => {
        const suggestions: RebalanceSuggestion[] = [
            { action: 'SELL', key: 'Technology', label: 'Technology', amount: 5_000, outsideBand: true },
        ];
        const mapping = mapSectorSuggestionsToSymbolTrades(suggestions, exposure.contributions);

        expect(mapping.bySector).toHaveLength(1);
        const group = mapping.bySector[0];
        expect(group.sector).toBe('Technology');
        expect(group.trades).toHaveLength(2);

        // Technology exposure: VTI 15k (60%), AAPL 10k (40%)
        const vti = group.trades.find(t => t.symbol === 'VTI')!;
        const aapl = group.trades.find(t => t.symbol === 'AAPL')!;
        expect(vti.amount).toBeCloseTo(3_000, 2);
        expect(aapl.amount).toBeCloseTo(2_000, 2);
        expect(vti.shareOfSector).toBeCloseTo(0.6, 3);
        expect(aapl.shareOfSector).toBeCloseTo(0.4, 3);
    });

    it('rounds slices to cents and assigns the residual to the largest contributor', () => {
        const contributions = {
            X: [
                { symbol: 'A', label: 'A', value: 100 },
                { symbol: 'B', label: 'B', value: 100 },
                { symbol: 'C', label: 'C', value: 100 },
            ],
        };
        const suggestions: RebalanceSuggestion[] = [
            { action: 'BUY', key: 'X', label: 'X', amount: 100, outsideBand: true },
        ];
        const mapping = mapSectorSuggestionsToSymbolTrades(suggestions, contributions);
        const trades = mapping.bySector[0].trades;

        // 100 / 3 = 33.33 each -> 99.99; residual 0.01 goes to the first (largest) slice
        const sum = trades.reduce((s, t) => s + t.amount, 0);
        expect(sum).toBeCloseTo(100, 10);
        expect(trades.find(t => t.symbol === 'A')!.amount).toBeCloseTo(33.34, 10);
        expect(trades.find(t => t.symbol === 'B')!.amount).toBeCloseTo(33.33, 10);
        expect(trades.find(t => t.symbol === 'C')!.amount).toBeCloseTo(33.33, 10);
    });

    it('nets a symbol appearing in multiple sector trades into one suggestion', () => {
        const suggestions: RebalanceSuggestion[] = [
            { action: 'SELL', key: 'Technology', label: 'Technology', amount: 5_000, outsideBand: true },
            { action: 'BUY', key: 'Healthcare', label: 'Healthcare', amount: 1_000, outsideBand: true },
        ];
        const mapping = mapSectorSuggestionsToSymbolTrades(suggestions, exposure.contributions);

        // VTI: sells 3000 (tech slice), buys 1000 (only healthcare contributor) -> net SELL 2000
        const vti = mapping.netBySymbol.find(s => s.key === 'VTI')!;
        expect(vti.action).toBe('SELL');
        expect(vti.amount).toBeCloseTo(2_000, 2);

        const aapl = mapping.netBySymbol.find(s => s.key === 'AAPL')!;
        expect(aapl.action).toBe('SELL');
        expect(aapl.amount).toBeCloseTo(2_000, 2);

        // Sells first, largest first
        expect(mapping.netBySymbol[0].action).toBe('SELL');
    });

    it('produces an empty trade list for a targeted but unheld sector', () => {
        const suggestions: RebalanceSuggestion[] = [
            { action: 'BUY', key: 'Energy', label: 'Energy', amount: 1_000, outsideBand: true },
        ];
        const mapping = mapSectorSuggestionsToSymbolTrades(suggestions, exposure.contributions);
        expect(mapping.bySector[0].trades).toEqual([]);
        expect(mapping.netBySymbol).toEqual([]);
    });
});

describe('sector mode + engine band behavior', () => {
    it('preserves threshold semantics on sector rows (only out-of-band trades)', () => {
        const exposure = holdingsToSectorExposure(holdings, metadata);
        // Totals: Technology 25k, Financials 25k, Healthcare 10k, Unclassified 5k (of 65k)
        const targets = [
            { key: 'Technology', targetPct: 30 },   // current ~38.5 -> +8.5 drift, outside band
            { key: 'Financials', targetPct: 40 },   // current ~38.5 -> -1.5 drift, inside band
            { key: 'Healthcare', targetPct: 20 },   // current ~15.4 -> -4.6 drift, inside band
            { key: UNCLASSIFIED_SECTOR, targetPct: 10 }, // current ~7.7 -> inside band
        ];
        const result = computeRebalance(exposure.holdings, targets, { bandPct: DEFAULT_BAND_PCT });

        expect(result.mode).toBe('full');
        const traded = result.suggestions.map(s => s.key);
        expect(traded).toEqual(['Technology']); // only the out-of-band sector
        expect(result.suggestions[0].action).toBe('SELL');
    });

    it('buy-only mode allocates new cash across underweight sectors', () => {
        const exposure = holdingsToSectorExposure(holdings, metadata);
        const targets = [
            { key: 'Technology', targetPct: 30 },
            { key: 'Financials', targetPct: 40 },
            { key: 'Healthcare', targetPct: 30 },
        ];
        const result = computeRebalance(exposure.holdings, targets, { newCash: 10_000 });
        expect(result.mode).toBe('buy-only');
        expect(result.suggestions.every(s => s.action === 'BUY')).toBe(true);
    });
});

describe('parseRebalanceConfig — migration', () => {
    it('reads the legacy {targets, bandPct} shape as symbol mode', () => {
        const config = parseRebalanceConfig({
            targets: [{ key: 'VTI', targetPct: 60 }, { key: 'BND', targetPct: 40 }],
            bandPct: 3,
        });
        expect(config.mode).toBe('symbol');
        expect(config.targetsBySymbol).toEqual([
            { key: 'VTI', targetPct: 60 },
            { key: 'BND', targetPct: 40 },
        ]);
        expect(config.targetsBySector).toEqual([]);
        expect(config.bandPct).toBe(3);
    });

    it('reads the current shape with both target lists', () => {
        const config = parseRebalanceConfig({
            mode: 'sector',
            targetsBySymbol: [{ key: 'VTI', targetPct: 100 }],
            targetsBySector: [{ key: 'Technology', targetPct: 100 }],
            bandPct: 7,
        });
        expect(config.mode).toBe('sector');
        expect(config.targetsBySymbol).toEqual([{ key: 'VTI', targetPct: 100 }]);
        expect(config.targetsBySector).toEqual([{ key: 'Technology', targetPct: 100 }]);
        expect(config.bandPct).toBe(7);
    });

    it('falls back to defaults for null / malformed configs', () => {
        for (const bad of [null, undefined, 'nope', 42, [], { targets: 'x', bandPct: -1 }]) {
            const config = parseRebalanceConfig(bad);
            expect(config.mode).toBe('symbol');
            expect(config.targetsBySymbol).toEqual([]);
            expect(config.targetsBySector).toEqual([]);
            expect(config.bandPct).toBe(DEFAULT_BAND_PCT);
        }
    });

    it('prefers targetsBySymbol over legacy targets when both exist', () => {
        const config = parseRebalanceConfig({
            mode: 'symbol',
            targets: [{ key: 'OLD', targetPct: 100 }],
            targetsBySymbol: [{ key: 'NEW', targetPct: 100 }],
            targetsBySector: [],
            bandPct: 5,
        });
        expect(config.targetsBySymbol).toEqual([{ key: 'NEW', targetPct: 100 }]);
    });

    it('ignores malformed target entries', () => {
        const config = parseRebalanceConfig({
            mode: 'sector',
            targetsBySector: [
                { key: 'Technology', targetPct: 50 },
                { key: 42, targetPct: 50 },
                { key: 'Healthcare' },
                'junk',
                null,
            ],
        });
        expect(config.targetsBySector).toEqual([{ key: 'Technology', targetPct: 50 }]);
    });
});
