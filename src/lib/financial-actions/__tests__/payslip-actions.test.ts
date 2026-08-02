import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.hoisted(() => vi.fn());
vi.mock('@/lib/prisma', () => ({
  default: {
    gnucash_web_payslips: { findMany },
  },
}));

import { payslipActions } from '../sources';

function payslip(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    book_guid: 'b'.repeat(32),
    pay_date: new Date('2026-07-31T00:00:00.000Z'),
    employer_name: 'Acme Co',
    gross_pay: 5_000,
    net_pay: 3_500,
    transaction_guid: null,
    status: 'ready',
    error_message: null,
    updated_at: new Date('2026-08-02T11:00:00.000Z'),
    ...overrides,
  };
}

describe('payslip Financial Action adapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T12:30:00.000Z'));
    findMany.mockReset();
  });

  afterEach(() => vi.useRealTimers());

  it('creates distinct useful actions for failed, unmatched, and unposted payslips', async () => {
    findMany.mockResolvedValue([
      payslip({ id: 1, status: 'error', error_message: 'Extraction failed' }),
      payslip({ id: 2, status: 'needs_mapping' }),
      payslip({ id: 3, status: 'ready', transaction_guid: 'a'.repeat(32) }),
    ]);

    const actions = await payslipActions('b'.repeat(32));
    expect(actions.map(action => action.stableKey)).toEqual([
      'payslip:1:failed',
      'payslip:2:unmatched',
      'payslip:3:unposted',
    ]);
    expect(actions.map(action => action.operations[0].label)).toEqual([
      'Review payslip',
      'Map accounts',
      'Review and post',
    ]);
    expect(actions[0].trace.evidence[0]).toMatchObject({
      kind: 'payslip',
      source: 'payslip',
      id: '1',
      verified: false,
    });
  });

  it('surfaces stuck processing but ignores active processing work', async () => {
    findMany.mockResolvedValue([
      payslip({ id: 1, status: 'processing', updated_at: new Date('2026-08-02T10:00:00.000Z') }),
      payslip({ id: 2, status: 'processing', updated_at: new Date('2026-08-02T12:15:00.000Z') }),
    ]);
    const actions = await payslipActions('b'.repeat(32));
    expect(actions).toHaveLength(1);
    expect(actions[0].stableKey).toBe('payslip:1:failed');
    expect(actions[0].trace.evidence[0].stale).toBe(true);
  });
});
