/**
 * Tax-Optimal Sell Planner — pure-core tests.
 *
 * All tests inject `asOf` and (mostly) mocked tax compute functions so no
 * DB, clock, or real IRS math is required except where stated.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  planSell,
  buildSellPlans,
  orderCandidates,
  daysUntilLongTerm,
  incrementalPlanTax,
  type SellLotCandidate,
  type SellTaxContext,
} from '@/lib/sell-planner';
import { emptyFederalInputs } from '@/lib/tax/federal';
import type { FederalTaxInputs } from '@/lib/tax/types';

const AS_OF = '2026-07-12';

/** Simple linear mock: ST taxed at 35%, LT at 15%, no state. */
function mockContext(overrides: Partial<SellTaxContext> = {}): SellTaxContext {
  return {
    baseline: emptyFederalInputs(2026, 'single'),
    stateCode: 'OTHER',
    computeFederal: (inputs: FederalTaxInputs) => ({
      totalTax:
        inputs.shortTermCapitalGains * 0.35 + inputs.longTermCapitalGains * 0.15,
      agi: 100_000 + inputs.shortTermCapitalGains + inputs.longTermCapitalGains,
    }),
    computeState: () => ({ tax: 0 }),
    ...overrides,
  };
}

let seq = 0;
function mkLot(overrides: Partial<SellLotCandidate> = {}): SellLotCandidate {
  seq += 1;
  return {
    lotGuid: `lot-${seq}`,
    accountGuid: 'acct-1',
    accountName: 'Brokerage',
    ticker: 'TEST',
    shares: 100,
    price: 10,
    costBasis: 1000, // break-even by default
    acquiredDate: '2024-01-15', // long-term by default
    ...overrides,
  };
}

describe('orderCandidates', () => {
  it('orders ST losses, LT losses, LT gains, ST gains', () => {
    const stGain = mkLot({ lotGuid: 'st-gain', acquiredDate: '2026-05-01', costBasis: 500 });
    const ltGain = mkLot({ lotGuid: 'lt-gain', acquiredDate: '2023-01-01', costBasis: 500 });
    const stLoss = mkLot({ lotGuid: 'st-loss', acquiredDate: '2026-05-01', costBasis: 1500 });
    const ltLoss = mkLot({ lotGuid: 'lt-loss', acquiredDate: '2023-01-01', costBasis: 1500 });

    const ordered = orderCandidates([stGain, ltGain, stLoss, ltLoss], AS_OF);
    expect(ordered.map(l => l.lotGuid)).toEqual(['st-loss', 'lt-loss', 'lt-gain', 'st-gain']);
  });

  it('orders gains by ascending gain-per-dollar-raised', () => {
    // Both LT gains, same market value ($1000): A realizes $500, B $200.
    const a = mkLot({ lotGuid: 'a', costBasis: 500 });
    const b = mkLot({ lotGuid: 'b', costBasis: 800 });
    const ordered = orderCandidates([a, b], AS_OF);
    expect(ordered.map(l => l.lotGuid)).toEqual(['b', 'a']);
  });
});

describe('planSell — recommended strategy', () => {
  it('harvests losses before touching gains', () => {
    const loss = mkLot({ lotGuid: 'loss', costBasis: 1300 });   // -$300
    const gain = mkLot({ lotGuid: 'gain', costBasis: 400 });    // +$600
    const plan = planSell([gain, loss], 1500, mockContext(), { asOf: AS_OF });

    expect(plan.sales[0].lotGuid).toBe('loss');
    expect(plan.sales[1].lotGuid).toBe('gain');
    expect(plan.targetMet).toBe(true);
    expect(plan.harvestedLoss).toBeCloseTo(-300, 2);
  });

  it('skips loss lots exposed to the wash-sale rule and reports them', () => {
    const washLoss = mkLot({ lotGuid: 'wash', ticker: 'AAPL', costBasis: 1400 });
    const cleanLoss = mkLot({ lotGuid: 'clean', ticker: 'MSFT', costBasis: 1200 });
    const gain = mkLot({ lotGuid: 'gain', ticker: 'VTI', costBasis: 600 });

    const plan = planSell([washLoss, cleanLoss, gain], 2000, mockContext(), {
      asOf: AS_OF,
      recentBuysByTicker: { AAPL: '2026-07-01' },
    });

    expect(plan.sales.map(s => s.lotGuid)).not.toContain('wash');
    expect(plan.skippedWashSales).toHaveLength(1);
    expect(plan.skippedWashSales[0]).toMatchObject({
      lotGuid: 'wash',
      ticker: 'AAPL',
      lastBuyDate: '2026-07-01',
    });
    expect(plan.skippedWashSales[0].unrealizedLoss).toBeCloseTo(-400, 2);
    expect(plan.warnings.some(w => w.includes('wash-sale'))).toBe(true);
  });

  it('does NOT skip gain lots of a recently-bought ticker (no loss, no wash)', () => {
    const gain = mkLot({ lotGuid: 'gain', ticker: 'AAPL', costBasis: 400 });
    const plan = planSell([gain], 500, mockContext(), {
      asOf: AS_OF,
      recentBuysByTicker: { AAPL: '2026-07-01' },
    });
    expect(plan.sales.map(s => s.lotGuid)).toContain('gain');
    expect(plan.skippedWashSales).toHaveLength(0);
  });

  it('computes partial-lot math pro-rata', () => {
    // 100 sh @ $10 = $1,000 mv, basis $500 → gain $500. Raise $250 → sell 25 sh.
    const lot = mkLot({ costBasis: 500 });
    const plan = planSell([lot], 250, mockContext(), { asOf: AS_OF });

    expect(plan.sales).toHaveLength(1);
    const sale = plan.sales[0];
    expect(sale.partial).toBe(true);
    expect(sale.sharesToSell).toBeCloseTo(25, 6);
    expect(sale.proceeds).toBeCloseTo(250, 2);
    expect(sale.costBasis).toBeCloseTo(125, 2);
    expect(sale.gain).toBeCloseTo(125, 2);
    expect(plan.totalProceeds).toBeCloseTo(250, 2);
  });

  it('meets the target exactly with a partial final lot', () => {
    // small has the lower gain-per-dollar so it is consumed first.
    const small = mkLot({ lotGuid: 'small', shares: 60, costBasis: 500 });  // mv $600, gpd 0.17
    const big = mkLot({ lotGuid: 'big', shares: 200, costBasis: 1000 });    // mv $2,000, gpd 0.50
    const plan = planSell([small, big], 1000, mockContext(), { asOf: AS_OF });

    expect(plan.totalProceeds).toBeCloseTo(1000, 2);
    expect(plan.targetMet).toBe(true);
    expect(plan.shortfall).toBe(0);
    const last = plan.sales[plan.sales.length - 1];
    expect(last.partial).toBe(true);
    expect(plan.sales[0].partial).toBe(false);
    // 60 full shares + 400/2000 of 200 shares = 40 shares
    expect(last.sharesToSell).toBeCloseTo(40, 6);
  });

  it('reports a shortfall when lots cannot cover the target', () => {
    const lot = mkLot({ shares: 10 }); // mv $100
    const plan = planSell([lot], 500, mockContext(), { asOf: AS_OF });
    expect(plan.targetMet).toBe(false);
    expect(plan.shortfall).toBeCloseTo(400, 2);
    expect(plan.warnings.some(w => w.includes('short'))).toBe(true);
  });

  it('flags almost-long-term ST gains with a wait-saves hint', () => {
    // Acquired 2025-08-01 → first long-term day 2026-08-02 → 21 days from AS_OF.
    const almost = mkLot({
      lotGuid: 'almost',
      acquiredDate: '2025-08-01',
      shares: 10,
      price: 20,
      costBasis: 100, // gain $100
    });
    // Far from LT: acquired last month.
    const far = mkLot({
      lotGuid: 'far',
      acquiredDate: '2026-06-01',
      shares: 10,
      price: 20,
      costBasis: 100,
    });
    const plan = planSell([almost, far], 400, mockContext(), {
      asOf: AS_OF,
      almostLongTermDays: 45,
    });

    const almostSale = plan.sales.find(s => s.lotGuid === 'almost')!;
    expect(almostSale.term).toBe('short_term');
    expect(almostSale.daysUntilLongTerm).toBe(21);
    expect(almostSale.almostLongTerm).toBe(true);
    // Mock rates: ST 35% vs LT 15% on a $100 gain → waiting saves $20.
    expect(almostSale.waitSavesTax).toBeCloseTo(20, 2);

    const farSale = plan.sales.find(s => s.lotGuid === 'far')!;
    expect(farSale.almostLongTerm).toBe(false);
    expect(farSale.waitSavesTax).toBeNull();

    expect(plan.warnings.some(w => w.includes('long-term within'))).toBe(true);
  });
});

describe('incremental tax', () => {
  it('delegates to the injected tax functions and reports the delta', () => {
    const computeFederal = vi.fn((inputs: FederalTaxInputs) => ({
      totalTax: 10_000 +
        inputs.shortTermCapitalGains * 0.32 + inputs.longTermCapitalGains * 0.15,
      agi: 200_000 + inputs.shortTermCapitalGains + inputs.longTermCapitalGains,
    }));
    const computeState = vi.fn((_code: string, inputs: { federalAgi: number }) => ({
      tax: inputs.federalAgi * 0.05,
    }));
    const baseline: FederalTaxInputs = {
      ...emptyFederalInputs(2026, 'mfj'),
      wages: 150_000,
      shortTermCapitalGains: 2_000,
      longTermCapitalGains: 5_000,
    };
    const ctx: SellTaxContext = {
      baseline,
      stateCode: 'CA',
      computeFederal,
      computeState: computeState as unknown as SellTaxContext['computeState'],
    };

    // One LT gain lot: mv $1,000, gain $400 — no almost-LT hints (LT already).
    const lot = mkLot({ costBasis: 600 });
    const plan = planSell([lot], 1000, ctx, { asOf: AS_OF });

    // Called exactly twice: baseline, baseline + plan gains.
    expect(computeFederal).toHaveBeenCalledTimes(2);
    expect(computeFederal.mock.calls[0][0].longTermCapitalGains).toBe(5_000);
    expect(computeFederal.mock.calls[1][0].longTermCapitalGains).toBeCloseTo(5_400, 2);
    expect(computeFederal.mock.calls[1][0].shortTermCapitalGains).toBe(2_000);

    // Federal delta = 400 * 0.15 = 60; state delta = 400 * 0.05 = 20.
    expect(plan.tax.federal).toBeCloseTo(60, 2);
    expect(plan.tax.state).toBeCloseTo(20, 2);
    expect(plan.tax.total).toBeCloseTo(80, 2);
    expect(plan.tax.effectiveRateOnRaise).toBeCloseTo(0.08, 4);
    expect(computeState).toHaveBeenCalledWith('CA', expect.objectContaining({
      federalAgi: expect.any(Number),
    }));
  });

  it('incrementalPlanTax nets losses through the real federal engine', () => {
    // Real engine: a harvested loss REDUCES tax vs baseline.
    const baseline: FederalTaxInputs = {
      ...emptyFederalInputs(2026, 'single'),
      wages: 120_000,
      shortTermCapitalGains: 4_000,
    };
    const ctx: SellTaxContext = { baseline, stateCode: 'OTHER' };
    const delta = incrementalPlanTax(ctx, -3_000, 0);
    expect(delta.federal).toBeLessThan(0);
  });
});

describe('comparison plans', () => {
  it('builds FIFO ordered strictly by acquisition date, flagging wash risk', () => {
    const newest = mkLot({ lotGuid: 'newest', acquiredDate: '2026-06-01', costBasis: 500 });
    const oldest = mkLot({ lotGuid: 'oldest', acquiredDate: '2020-03-10', costBasis: 1400, ticker: 'AAPL' });
    const middle = mkLot({ lotGuid: 'middle', acquiredDate: '2023-09-20', costBasis: 900 });

    const plans = buildSellPlans([newest, oldest, middle], 2500, mockContext(), {
      asOf: AS_OF,
      recentBuysByTicker: { AAPL: '2026-07-05' },
    });

    expect(plans.fifo.sales.map(s => s.lotGuid)).toEqual(['oldest', 'middle', 'newest']);
    // FIFO does not skip the wash-exposed loss lot — it flags it.
    const washSale = plans.fifo.sales.find(s => s.lotGuid === 'oldest')!;
    expect(washSale.washSaleRisk).toBe(true);
    expect(plans.fifo.skippedWashSales).toHaveLength(0);
    // The recommended plan skips it instead.
    expect(plans.recommended.sales.map(s => s.lotGuid)).not.toContain('oldest');
    expect(plans.recommended.skippedWashSales.map(s => s.lotGuid)).toEqual(['oldest']);
  });

  it('long-term-only uses only LT lots and may miss the target', () => {
    const lt = mkLot({ lotGuid: 'lt', acquiredDate: '2023-01-01', costBasis: 800 });     // mv $1,000
    const st = mkLot({ lotGuid: 'st', acquiredDate: '2026-05-01', costBasis: 800 });     // mv $1,000

    const plans = buildSellPlans([lt, st], 1500, mockContext(), { asOf: AS_OF });

    expect(plans.longTermOnly.sales.map(s => s.lotGuid)).toEqual(['lt']);
    expect(plans.longTermOnly.targetMet).toBe(false);
    expect(plans.longTermOnly.shortfall).toBeCloseTo(500, 2);

    // Recommended meets it by adding the ST lot after the LT one.
    expect(plans.recommended.targetMet).toBe(true);
    expect(plans.recommended.sales.map(s => s.lotGuid)).toEqual(['lt', 'st']);
  });

  it('recommended plan is never more expensive than FIFO on the same book (mock rates)', () => {
    const lots = [
      mkLot({ lotGuid: 'old-big-gain', acquiredDate: '2019-01-01', costBasis: 100 }),   // LT +$900
      mkLot({ lotGuid: 'st-small-gain', acquiredDate: '2026-04-01', costBasis: 950 }),  // ST +$50
      mkLot({ lotGuid: 'lt-loss', acquiredDate: '2022-06-01', costBasis: 1200 }),       // LT -$200
    ];
    const plans = buildSellPlans(lots, 1800, mockContext(), { asOf: AS_OF });
    expect(plans.recommended.tax.total).toBeLessThanOrEqual(plans.fifo.tax.total);
    expect(plans.recommended.targetMet).toBe(true);
    expect(plans.fifo.targetMet).toBe(true);
  });
});

describe('daysUntilLongTerm', () => {
  it('counts days to the first strictly-long-term day', () => {
    // Acquired 2025-07-12: one year later is 2026-07-12; long-term requires
    // strictly after, so the first LT day is 2026-07-13 → 1 day away.
    const lot = mkLot({ acquiredDate: '2025-07-12' });
    expect(daysUntilLongTerm(lot, AS_OF)).toBe(1);
  });

  it('returns 0 for lots already long-term', () => {
    const lot = mkLot({ acquiredDate: '2024-01-01' });
    expect(daysUntilLongTerm(lot, AS_OF)).toBe(0);
  });
});
