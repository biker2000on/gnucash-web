import { describe, it, expect } from 'vitest';
import {
    computeRebalance,
    orderSellCandidates,
    annotateSellSuggestions,
    DEFAULT_BAND_PCT,
    type RebalanceHolding,
    type RebalanceTarget,
    type SellLotCandidate,
} from '@/lib/rebalancing';

const holdings: RebalanceHolding[] = [
    { key: 'VTI', label: 'Vanguard Total Stock', currentValue: 60_000 },
    { key: 'BND', label: 'Vanguard Total Bond', currentValue: 25_000 },
    { key: 'VXUS', label: 'Vanguard Intl', currentValue: 15_000 },
];

const targets: RebalanceTarget[] = [
    { key: 'VTI', targetPct: 50 },
    { key: 'BND', targetPct: 30 },
    { key: 'VXUS', targetPct: 20 },
];

function row(result: ReturnType<typeof computeRebalance>, key: string) {
    const r = result.rows.find(x => x.key === key);
    expect(r, `row ${key} should exist`).toBeDefined();
    return r!;
}

describe('computeRebalance — drift math', () => {
    it('computes currentPct, driftPct, and dollar delta per key', () => {
        const result = computeRebalance(holdings, targets);

        expect(result.totalValue).toBe(100_000);
        expect(result.mode).toBe('full');
        expect(result.bandPct).toBe(DEFAULT_BAND_PCT);

        const vti = row(result, 'VTI');
        expect(vti.currentPct).toBeCloseTo(60, 5);
        expect(vti.targetPct).toBeCloseTo(50, 5);
        expect(vti.driftPct).toBeCloseTo(10, 5);
        expect(vti.targetValue).toBeCloseTo(50_000, 2);
        expect(vti.delta).toBeCloseTo(-10_000, 2); // sell 10k

        const bnd = row(result, 'BND');
        expect(bnd.driftPct).toBeCloseTo(-5, 5);
        expect(bnd.delta).toBeCloseTo(5_000, 2);

        const vxus = row(result, 'VXUS');
        expect(vxus.driftPct).toBeCloseTo(-5, 5);
        expect(vxus.delta).toBeCloseTo(5_000, 2);
    });

    it('handles empty holdings with targets (targets with no holdings)', () => {
        const result = computeRebalance([], targets);
        expect(result.totalValue).toBe(0);
        const vti = row(result, 'VTI');
        expect(vti.currentValue).toBe(0);
        expect(vti.currentPct).toBe(0);
        expect(vti.missingHolding).toBe(true);
        expect(result.warnings.some(w => w.includes('no current holding'))).toBe(true);
    });
});

describe('computeRebalance — normalization', () => {
    it('normalizes targets that do not sum to 100 and warns', () => {
        const skewed: RebalanceTarget[] = [
            { key: 'VTI', targetPct: 25 },
            { key: 'BND', targetPct: 15 },
            { key: 'VXUS', targetPct: 10 },
        ]; // sums to 50 -> doubled
        const result = computeRebalance(holdings, skewed);

        expect(result.warnings.some(w => w.includes('normalized'))).toBe(true);
        expect(row(result, 'VTI').targetPct).toBeCloseTo(50, 5);
        expect(row(result, 'BND').targetPct).toBeCloseTo(30, 5);
        expect(row(result, 'VXUS').targetPct).toBeCloseTo(20, 5);

        // Normalized targets sum to 100
        const sum = result.rows.reduce((s, r) => s + r.targetPct, 0);
        expect(sum).toBeCloseTo(100, 1);
    });

    it('does not warn when targets sum to 100', () => {
        const result = computeRebalance(holdings, targets);
        expect(result.warnings.some(w => w.includes('normalized'))).toBe(false);
    });

    it('treats a held key without a target as 0% and warns', () => {
        const partialTargets: RebalanceTarget[] = [
            { key: 'VTI', targetPct: 70 },
            { key: 'BND', targetPct: 30 },
        ];
        const result = computeRebalance(holdings, partialTargets);

        const vxus = row(result, 'VXUS');
        expect(vxus.targetPct).toBe(0);
        expect(vxus.missingTarget).toBe(true);
        expect(vxus.delta).toBeCloseTo(-15_000, 2); // full sell to reach 0%
        expect(result.warnings.some(w => w.includes('without a target') && w.includes('VXUS'))).toBe(true);
    });

    it('emits warning and no suggestions when no targets are defined', () => {
        const result = computeRebalance(holdings, []);
        expect(result.warnings.some(w => w.includes('No target allocation'))).toBe(true);
        expect(result.suggestions).toHaveLength(0);
    });
});

describe('computeRebalance — buy-only mode (new cash)', () => {
    it('allocates new cash to underweights proportionally to shortfall', () => {
        const newCash = 6_000;
        const result = computeRebalance(holdings, targets, { newCash });

        expect(result.mode).toBe('buy-only');
        expect(result.targetBase).toBe(106_000);
        expect(result.suggestions.every(s => s.action === 'BUY')).toBe(true);

        // Target values on base 106k: VTI 53k (held 60k -> no shortfall),
        // BND 31.8k (shortfall 6.8k), VXUS 21.2k (shortfall 6.2k). Total 13k.
        const bnd = result.suggestions.find(s => s.key === 'BND')!;
        const vxus = result.suggestions.find(s => s.key === 'VXUS')!;
        expect(result.suggestions.find(s => s.key === 'VTI')).toBeUndefined();

        expect(bnd.amount).toBeCloseTo(6_000 * (6_800 / 13_000), 1);
        expect(vxus.amount).toBeCloseTo(6_000 * (6_200 / 13_000), 1);

        // All cash deployed
        const totalBuys = result.suggestions.reduce((s, x) => s + x.amount, 0);
        expect(totalBuys).toBeCloseTo(newCash, 1);

        // Proportionality: ratio of buys equals ratio of shortfalls
        expect(bnd.amount / vxus.amount).toBeCloseTo(6_800 / 6_200, 3);
    });

    it('never suggests sells in buy-only mode even for overweights', () => {
        const result = computeRebalance(holdings, targets, { newCash: 1_000 });
        expect(result.suggestions.some(s => s.action === 'SELL')).toBe(false);
    });

    it('deploys all cash when a large infusion makes every key underweight', () => {
        // Massive cash infusion: target base doubles, so even the currently
        // overweight key (VTI at 60%) develops a shortfall and receives buys.
        const newCash = 100_000;
        const result = computeRebalance(holdings, targets, { newCash });

        const totalBuys = result.suggestions.reduce((s, x) => s + x.amount, 0);
        expect(totalBuys).toBeCloseTo(newCash, 0);
        expect(result.suggestions.find(s => s.key === 'VTI')).toBeDefined();
        expect(result.suggestions.every(s => s.action === 'BUY')).toBe(true);

        // Shortfalls on base 200k: VTI 40k, BND 35k, VXUS 25k (sum 100k = cash)
        expect(result.suggestions.find(s => s.key === 'VTI')!.amount).toBeCloseTo(40_000, 0);
        expect(result.suggestions.find(s => s.key === 'BND')!.amount).toBeCloseTo(35_000, 0);
        expect(result.suggestions.find(s => s.key === 'VXUS')!.amount).toBeCloseTo(25_000, 0);
    });
});

describe('computeRebalance — full rebalance mode', () => {
    // Regression: ISSUE-003 — full-rebalance suggested trades for holdings
    // that were inside the tolerance band, contradicting the band's purpose
    // and proposing needless taxable sells.
    // Found by /qa on 2026-07-08
    // Report: .gstack/qa-reports/qa-report-gnucash-web-2026-07-08.md
    it('trades only out-of-band holdings and surfaces the cash remainder', () => {
        // VTI drift +10 (outside default band 5); BND/VXUS drift -5 (inside)
        const result = computeRebalance(holdings, targets);

        expect(result.suggestions).toHaveLength(1);
        const sell = result.suggestions[0];
        expect(sell.key).toBe('VTI');
        expect(sell.action).toBe('SELL');
        expect(sell.amount).toBeCloseTo(10_000, 2);
        expect(sell.outsideBand).toBe(true);

        // The un-netted proceeds are called out
        expect(result.warnings.some(w => w.includes('sells exceed buys'))).toBe(true);
    });

    it('produces no suggestions when every holding is within the band', () => {
        const result = computeRebalance(holdings, targets, { bandPct: 15 });
        expect(result.suggestions).toHaveLength(0);
        expect(result.warnings.some(w => w.includes('exceed'))).toBe(false);
    });

    it('nets to ~zero when every key is out of band', () => {
        // Tight band: all three keys are outside, so the full exact-to-target
        // trade set is produced and sells fund the buys exactly.
        const result = computeRebalance(holdings, targets, { bandPct: 2 });
        const net = result.suggestions.reduce(
            (s, x) => s + (x.action === 'BUY' ? x.amount : -x.amount),
            0
        );
        expect(net).toBeCloseTo(0, 1);
        expect(result.suggestions).toHaveLength(3);
    });

    it('normalizes unnormalized targets to the same trade set', () => {
        const skewed: RebalanceTarget[] = [
            { key: 'VTI', targetPct: 5 },
            { key: 'BND', targetPct: 3 },
            { key: 'VXUS', targetPct: 2 },
        ];
        const result = computeRebalance(holdings, skewed, { bandPct: 2 });
        const normalized = computeRebalance(holdings, targets, { bandPct: 2 });
        expect(result.suggestions).toEqual(normalized.suggestions);
    });

    it('lists sells before buys', () => {
        const result = computeRebalance(holdings, targets, { bandPct: 2 });
        const firstBuy = result.suggestions.findIndex(s => s.action === 'BUY');
        const lastSell = result.suggestions
            .map((s, i) => (s.action === 'SELL' ? i : -1))
            .reduce((a, b) => Math.max(a, b), -1);
        expect(firstBuy).toBeGreaterThan(-1);
        expect(lastSell).toBeLessThan(firstBuy);
    });
});

describe('computeRebalance — band filtering', () => {
    it('flags keys outside the default 5-point absolute band', () => {
        const result = computeRebalance(holdings, targets);
        // VTI drift +10 -> outside; BND/VXUS drift -5 -> exactly at band edge, inside
        expect(row(result, 'VTI').outsideBand).toBe(true);
        expect(row(result, 'BND').outsideBand).toBe(false);
        expect(row(result, 'VXUS').outsideBand).toBe(false);
    });

    it('respects a custom band', () => {
        const result = computeRebalance(holdings, targets, { bandPct: 2 });
        expect(row(result, 'VTI').outsideBand).toBe(true);
        expect(row(result, 'BND').outsideBand).toBe(true);
        expect(row(result, 'VXUS').outsideBand).toBe(true);

        const wide = computeRebalance(holdings, targets, { bandPct: 15 });
        expect(wide.rows.every(r => !r.outsideBand)).toBe(true);
    });

    it('propagates the band flag onto suggestions (all outside in full mode)', () => {
        const result = computeRebalance(holdings, targets);
        expect(result.suggestions.every(s => s.outsideBand)).toBe(true);
        // In-band BND is not traded at all in full-rebalance mode
        expect(result.suggestions.find(s => s.key === 'BND')).toBeUndefined();
    });
});

describe('tax-aware sell ordering', () => {
    const lots: SellLotCandidate[] = [
        { lotGuid: 'st-gain', accountGuid: 'a1', title: 'ST gain', marketValue: 5_000, unrealizedGain: 800, term: 'short_term' },
        { lotGuid: 'lt-gain-big', accountGuid: 'a1', title: 'LT gain big', marketValue: 5_000, unrealizedGain: 2_000, term: 'long_term' },
        { lotGuid: 'loss-small', accountGuid: 'a1', title: 'Small loss', marketValue: 4_000, unrealizedGain: -200, term: 'short_term' },
        { lotGuid: 'lt-gain-small', accountGuid: 'a1', title: 'LT gain small', marketValue: 3_000, unrealizedGain: 100, term: 'long_term' },
        { lotGuid: 'loss-big', accountGuid: 'a1', title: 'Big loss', marketValue: 6_000, unrealizedGain: -1_500, term: 'long_term' },
    ];

    it('orders losses first (biggest loss first), then LT gains, then ST gains', () => {
        const ordered = orderSellCandidates(lots);
        expect(ordered.map(l => l.lotGuid)).toEqual([
            'loss-big',      // -1500
            'loss-small',    // -200
            'lt-gain-small', // LT +100
            'lt-gain-big',   // LT +2000
            'st-gain',       // ST +800
        ]);
    });

    it('treats unknown-term gains as short-term (last)', () => {
        const ordered = orderSellCandidates([
            { lotGuid: 'unknown', accountGuid: 'a', title: 'u', marketValue: 100, unrealizedGain: 50, term: null },
            { lotGuid: 'lt', accountGuid: 'a', title: 'lt', marketValue: 100, unrealizedGain: 500, term: 'long_term' },
        ]);
        expect(ordered.map(l => l.lotGuid)).toEqual(['lt', 'unknown']);
    });

    it('annotates a sell with estimated realized gain and term breakdown', () => {
        const suggestions = annotateSellSuggestions(
            [{ action: 'SELL', key: 'VTI', label: 'VTI', amount: 8_000, outsideBand: true }],
            { VTI: lots }
        );
        const tax = suggestions[0].tax!;

        // 8k sell consumes: loss-big (6k, gain -1500) fully,
        // then loss-small (2k of 4k -> half of -200 = -100)
        expect(tax.lots.map(l => l.lotGuid)).toEqual(['loss-big', 'loss-small']);
        expect(tax.lots[0].sellValue).toBeCloseTo(6_000, 2);
        expect(tax.lots[0].estimatedGain).toBeCloseTo(-1_500, 2);
        expect(tax.lots[1].sellValue).toBeCloseTo(2_000, 2);
        expect(tax.lots[1].estimatedGain).toBeCloseTo(-100, 2);

        expect(tax.estimatedGain).toBeCloseTo(-1_600, 2);
        expect(tax.harvestedLoss).toBeCloseTo(-1_600, 2);
        expect(tax.shortTermGain).toBe(0);
        expect(tax.longTermGain).toBe(0);
        expect(tax.coverage).toBeCloseTo(1, 3);
    });

    it('splits gains into short/long term buckets when sell reaches gain lots', () => {
        const suggestions = annotateSellSuggestions(
            [{ action: 'SELL', key: 'VTI', label: 'VTI', amount: 23_000, outsideBand: true }],
            { VTI: lots }
        );
        const tax = suggestions[0].tax!;

        // Consumes all 23k of market value: -1500 -200 +100 +2000 +800 = +1200
        expect(tax.estimatedGain).toBeCloseTo(1_200, 2);
        expect(tax.harvestedLoss).toBeCloseTo(-1_700, 2);
        expect(tax.longTermGain).toBeCloseTo(2_100, 2);
        expect(tax.shortTermGain).toBeCloseTo(800, 2);
        expect(tax.coverage).toBeCloseTo(1, 3);
    });

    it('reports partial coverage when lots cannot cover the sell amount', () => {
        const suggestions = annotateSellSuggestions(
            [{ action: 'SELL', key: 'VTI', label: 'VTI', amount: 50_000, outsideBand: true }],
            { VTI: lots } // total lot market value = 23k
        );
        const tax = suggestions[0].tax!;
        expect(tax.coverage).toBeCloseTo(23_000 / 50_000, 3);
    });

    it('leaves BUY suggestions untouched and handles missing lot data', () => {
        const suggestions = annotateSellSuggestions(
            [
                { action: 'BUY', key: 'BND', label: 'BND', amount: 5_000, outsideBand: false },
                { action: 'SELL', key: 'ZZZ', label: 'ZZZ', amount: 1_000, outsideBand: true },
            ],
            {}
        );
        expect(suggestions[0].tax).toBeUndefined();
        expect(suggestions[1].tax).toBeDefined();
        expect(suggestions[1].tax!.coverage).toBe(0);
        expect(suggestions[1].tax!.lots).toHaveLength(0);
    });
});

describe('computeRebalance — misc edge cases', () => {
    it('merges duplicate holding keys', () => {
        const dup: RebalanceHolding[] = [
            { key: 'VTI', label: 'VTI (IRA)', currentValue: 30_000 },
            { key: 'VTI', label: 'VTI (Brokerage)', currentValue: 30_000 },
        ];
        const result = computeRebalance(dup, [{ key: 'VTI', targetPct: 100 }]);
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].currentValue).toBe(60_000);
        expect(result.rows[0].currentPct).toBeCloseTo(100, 5);
    });

    it('clamps negative newCash to zero (stays full-rebalance mode)', () => {
        const result = computeRebalance(holdings, targets, { newCash: -500 });
        expect(result.newCash).toBe(0);
        expect(result.mode).toBe('full');
    });

    it('warns and skips suggestions when targets sum to zero', () => {
        const result = computeRebalance(holdings, [{ key: 'VTI', targetPct: 0 }]);
        expect(result.warnings.some(w => w.includes('sum to 0%'))).toBe(true);
        expect(result.suggestions).toHaveLength(0);
    });
});
