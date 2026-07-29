import { describe, expect, it } from 'vitest';
import {
  attributePlanVariance,
  normalizeGuardrails,
  normalizeLifeEvents,
} from '../living-plan';
import type { ScenarioBaseline } from '@/lib/scenario/types';

function baseline(overrides: Partial<ScenarioBaseline> = {}): ScenarioBaseline {
  return {
    asOfDate: '2026-07-23',
    netWorth: 500_000,
    liquidBalance: 40_000,
    investedAssets: 300_000,
    monthlyIncome: 10_000,
    monthlyExpenses: 6_000,
    monthlyNet: 4_000,
    savingsRatePct: 40,
    filingStatus: 'single',
    state: 'NC',
    stateFlatRatePct: 3.99,
    currentAge: 40,
    currentTaxYear: 2026,
    nextTaxYear: 2026,
    federalInputsCurrentYear: {} as ScenarioBaseline['federalInputsCurrentYear'],
    federalInputsNextYear: {} as ScenarioBaseline['federalInputsNextYear'],
    ...overrides,
  };
}

describe('Living Plan normalization and reconciliation', () => {
  it('keeps valid life events and rejects malformed dates/titles', () => {
    const events = normalizeLifeEvents([
      { id: 'move', type: 'move', title: 'Move closer to family', date: '2027-05-01', cashImpact: -20_000 },
      { type: 'unknown', title: 'Fallback event', date: '2028-01-01' },
      { type: 'retirement', title: '', date: '2045-01-01' },
      { type: 'child', title: 'Child', date: 'tomorrow' },
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ id: 'move', type: 'move', cashImpact: -20_000 });
    expect(events[1].type).toBe('custom');
  });

  it('fails safe to default guardrails and clamps negative minimum cash', () => {
    expect(normalizeGuardrails({ minimumCash: -50, contributionPriority: [] })).toMatchObject({
      minimumCash: 0,
      contributionPriority: [],
      enforceGoalDeadlines: true,
    });
    expect(normalizeGuardrails(null).minimumCash).toBeGreaterThan(0);
  });

  it('attributes plan drift to income, spending, markets, and liquidity', () => {
    const causes = attributePlanVariance(
      baseline(),
      baseline({
        monthlyIncome: 11_000,
        monthlyExpenses: 6_500,
        investedAssets: 320_000,
        liquidBalance: 35_000,
      }),
    );
    expect(Object.fromEntries(causes.map(cause => [cause.key, cause.amount]))).toEqual({
      market: 20_000,
      income: 12_000,
      spending: -6_000,
      liquidity: -5_000,
    });
  });
});
