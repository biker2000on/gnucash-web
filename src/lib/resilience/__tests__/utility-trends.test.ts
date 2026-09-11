import { describe, expect, it } from 'vitest';
import { buildUtilityTrends } from '../utility-trends';
import type { UtilityBill } from '../types';

const bill = (patch: Partial<UtilityBill> = {}): UtilityBill => ({ id: 'one', date: '2026-01-10', type: 'electric', provider: 'Duke', unit: 'kWh', usage: 100, totalCost: 20, ...patch });
const fee = (amount: number, label = 'Customer charge') => ({ label, amount, category: 'fee' as const });

describe('utility trends', () => {
  it('sorts and sums monthly bills, preserving gaps and real zero usage', () => {
    const result = buildUtilityTrends([bill({ date: '2026-03-01', usage: 0, totalCost: 5 }), bill(), bill({ id: 'two', usage: 50, totalCost: 10 })], { type: 'electric' });
    expect(result.months.map(month => [month.month, month.cost, month.usage.kWh, month.billCount])).toEqual([
      ['2026-01', 30, 150, 2], ['2026-02', null, undefined, 0], ['2026-03', 5, 0, 1],
    ]);
  });
  it('keeps unknown breakdowns distinct from known zero and aggregate-only fees', () => {
    const result = buildUtilityTrends([bill({ charges: [fee(10)] }), bill({ date: '2026-02-10' }), bill({ date: '2026-03-10', feeCost: 12 }), bill({ date: '2026-04-10', feeCost: 0 })], { type: 'electric' });
    const customer = result.feeTypes.find(item => item.label === 'Customer charge')!;
    expect(result.months.map(month => month.feeTotal)).toEqual([10, null, 12, 0]);
    expect(result.months.map(month => month.fees[customer.id])).toEqual([10, null, null, 0]);
    expect(result.missingBreakdowns).toBe(1);
  });
  it('normalizes label whitespace and case, sums repeats and credits without double-counting summaries', () => {
    const result = buildUtilityTrends([bill({ charges: [fee(12), fee(-2, ' CUSTOMER   CHARGE ')], feeCost: 10 }), bill({ date: '2026-02-10', charges: [fee(15)] })], { type: 'electric' });
    expect(result.feeTypes).toHaveLength(1);
    expect(result.months.map(month => month.feeTotal)).toEqual([10, 15]);
    expect(result.comparisons[0]).toMatchObject({ first: 10, latest: 15, delta: 5, percent: 50 });
  });
  it('does not invent percentages from zero or changes from one observation', () => {
    const result = buildUtilityTrends([bill({ charges: [fee(0)] }), bill({ date: '2026-02-10', charges: [fee(8)] })], { type: 'electric' });
    expect(result.comparisons[0]).toMatchObject({ delta: 8, percent: null });
    const single = buildUtilityTrends([bill({ charges: [fee(8)] })], { type: 'electric' });
    expect(single.comparisons[0].delta).toBeNull();
  });
  it('filters by type, provider and inclusive dates, keeping units separate', () => {
    const result = buildUtilityTrends([bill(), bill({ provider: 'Other' }), bill({ type: 'gas', unit: 'therms' }), bill({ date: '2025-12-31' }), bill({ id: 'two', unit: 'gallons', usage: 7 })], { type: 'electric', provider: 'Duke', from: '2026-01-10', to: '2026-01-10' });
    expect(result.billCount).toBe(2);
    expect(result.months[0].usage).toEqual({ kWh: 100, gallons: 7 });
    expect(buildUtilityTrends([], { type: 'water' }).months).toEqual([]);
  });
  it('does not understate a month that includes a bill without fee data', () => {
    const result = buildUtilityTrends([bill({ charges: [fee(10)] }), bill({ id: 'unknown' })], { type: 'electric' });
    expect(result.months[0].feeTotal).toBeNull();
    expect(result.months[0].cost).toBe(40);
  });
});
