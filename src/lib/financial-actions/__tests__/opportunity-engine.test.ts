import { describe, expect, it } from 'vitest';
import {
  detectOpportunities,
  scoreOpportunity,
  type OpportunitySignal,
} from '../opportunity-engine';

function signal(key: string, overrides: Partial<OpportunitySignal> = {}): OpportunitySignal {
  return {
    key,
    title: `Opportunity ${key}`,
    summary: `Deterministic opportunity ${key}`,
    href: `/tools/${key}`,
    valueLow: 500,
    valueHigh: 1_000,
    impactPeriod: 'annual',
    cashRequired: 0,
    urgency: 60,
    confidence: 0.9,
    liquidityCost: 10,
    reversibility: 80,
    goalAlignment: 70,
    ...overrides,
  };
}

describe('Opportunity Engine', () => {
  it('emits one inspectable action from each of the eight P0 packs', () => {
    const actions = detectOpportunities({
      asOfDate: '2026-07-23',
      estimatedTax: signal('tax'),
      contributionCapacity: [signal('contribution')],
      debtPaydown: signal('debt'),
      emergencyFund: signal('reserve'),
      portfolio: [signal('portfolio')],
      taxStrategy: [signal('harvest')],
      subscriptions: [signal('subscription')],
      budgetGaps: [signal('budget')],
    });

    expect(actions).toHaveLength(8);
    expect(new Set(actions.map(action => action.metadata?.opportunityPack))).toEqual(new Set([
      'estimated-tax',
      'contribution-capacity',
      'debt-vs-cash',
      'emergency-fund',
      'portfolio',
      'tax-strategy',
      'subscriptions',
      'budget-gaps',
    ]));
    for (const action of actions) {
      expect(action.lane).toBe('decide');
      expect(action.operations.map(operation => operation.id)).toEqual([
        'review',
        'plan-impact',
        'accept',
        'dismiss',
      ]);
      expect(action.trace.steps).toHaveLength(2);
      expect(action.trace.range).toEqual(action.impact
        ? { low: action.impact.low, high: action.impact.high }
        : undefined);
    }
  });

  it('rejects low-confidence, invalid, and valueless signals', () => {
    const actions = detectOpportunities({
      asOfDate: '2026-07-23',
      portfolio: [
        signal('low-confidence', { confidence: 0.64 }),
        signal('negative-range', { valueLow: 1_000, valueHigh: 500 }),
        signal('zero-value', { valueLow: 0, valueHigh: 0 }),
        signal('valid'),
      ],
    });

    expect(actions.map(action => action.sourceId)).toEqual(['portfolio:valid']);
  });

  it('ranks higher-value, urgent, confident opportunities first', () => {
    const actions = detectOpportunities({
      asOfDate: '2026-07-23',
      subscriptions: [
        signal('small', {
          valueLow: 25,
          valueHigh: 50,
          urgency: 30,
          confidence: 0.7,
        }),
        signal('large', {
          valueLow: 5_000,
          valueHigh: 10_000,
          urgency: 95,
          confidence: 0.98,
        }),
      ],
    });

    expect(actions.map(action => action.sourceId)).toEqual([
      'subscriptions:large',
      'subscriptions:small',
    ]);
    expect(actions[0].score!.total).toBeGreaterThan(actions[1].score!.total);
  });

  it('penalizes liquidity cost and cash requirements while clamping inputs', () => {
    const flexible = scoreOpportunity(signal('flexible'));
    const illiquid = scoreOpportunity(signal('illiquid', {
      cashRequired: 100_000,
      liquidityCost: 100,
      urgency: 1_000,
      confidence: 2,
      reversibility: -20,
    }));

    expect(illiquid.urgency).toBe(100);
    expect(illiquid.confidence).toBe(100);
    expect(illiquid.reversibility).toBe(0);
    expect(flexible.total).toBeGreaterThan(0);
    expect(illiquid.total).toBeGreaterThanOrEqual(0);
    expect(illiquid.total).toBeLessThanOrEqual(100);
  });

  it('keeps economic impact separate from the liquidity required to act', () => {
    const action = detectOpportunities({
      asOfDate: '2026-07-23',
      estimatedTax: signal('tax-shortfall', {
        valueLow: 200,
        valueHigh: 800,
        impactPeriod: 'one_time',
        cashRequired: 10_000,
      }),
    })[0];

    expect(action.impact).toEqual({
      low: 200,
      high: 800,
      period: 'one_time',
    });
    expect(action.metadata?.cashRequired).toBe(10_000);
    expect(action.trace.metadata?.cashRequired).toBe(10_000);
  });

  it('keeps trace IDs stable when only calculated values change', () => {
    const first = detectOpportunities({
      asOfDate: '2026-07-23',
      debtPaydown: signal('card', { valueLow: 200, valueHigh: 400 }),
    })[0];
    const second = detectOpportunities({
      asOfDate: '2026-08-23',
      debtPaydown: signal('card', { valueLow: 400, valueHigh: 800 }),
    })[0];

    expect(first.trace.id).toBe(second.trace.id);
    expect(first.trace.result).not.toBe(second.trace.result);
  });
});
