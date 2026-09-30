import { describe, expect, it } from 'vitest';
import {
  allocatedCents,
  allocationError,
  approvalBlockers,
  chooseSuggestion,
  contributionSplits,
  describeSplitAllocation,
  evaluateAccountablePlan,
  formatCents,
  householdSettlementSplits,
  isBalanced,
  percentOf,
  receivableDifferenceCents,
  remainderCents,
  summarizeByAccount,
  toCents,
  type AllocationRow,
} from '../model';

describe('money helpers', () => {
  it('converts to cents without float drift', () => {
    expect(toCents(62.22)).toBe(6222);
    expect(toCents('0.29')).toBe(29);
    expect(formatCents(209121)).toBe('$2,091.21');
    expect(formatCents(-5)).toBe('-$0.05');
    expect(percentOf(6222, 50)).toBe(3111);
  });
});

describe('allocation', () => {
  const rows: AllocationRow[] = [
    { kind: 'business', amountCents: 4000, reportStatus: 'submitted' },
    { kind: 'business', amountCents: 1000, reportStatus: 'rejected' },
    { kind: 'personal', amountCents: 2222, reportStatus: null },
  ];

  it('counts only live business lines', () => {
    expect(allocatedCents(rows)).toBe(4000);
    expect(remainderCents(6222, rows)).toBe(2222);
  });

  it('refuses over-allocation and non-charges', () => {
    expect(allocationError(6222, rows, 2222)).toBeNull();
    expect(allocationError(6222, rows, 2223)).toMatch(/Only \$22\.22 of this \$62\.22 charge/);
    expect(allocationError(-500, [], 100)).toMatch(/debits/);
    expect(allocationError(6222, [], 0)).toMatch(/greater than zero/);
    expect(allocationError(6222, [], 1.5)).toMatch(/greater than zero/);
  });
});

describe('evaluateAccountablePlan', () => {
  const base = {
    expenseDate: '2027-01-10',
    submittedDate: '2027-03-01',
    hasReceipt: false,
    businessPurpose: '',
    deadlineDays: 60,
  };

  it('does not apply to a disregarded entity', () => {
    expect(evaluateAccountablePlan({ ...base, taxClassification: 'disregarded' })).toMatchObject({
      required: false,
      missing: [],
      late: false,
    });
  });

  it('requires evidence for an S-corp and flags late submission', () => {
    const r = evaluateAccountablePlan({ ...base, taxClassification: 's_corp' });
    expect(r.required).toBe(true);
    expect(r.missing).toEqual(['receipt', 'business_purpose']);
    expect(r.daysSinceExpense).toBe(50);
    expect(r.late).toBe(false);
    const late = evaluateAccountablePlan({
      ...base,
      taxClassification: 'c_corp',
      submittedDate: '2027-03-15',
      hasReceipt: true,
      businessPurpose: 'CPR certification',
    });
    expect(late).toMatchObject({ missing: [], late: true, daysSinceExpense: 64 });
  });
});

describe('chooseSuggestion', () => {
  it('prefers a rule, then a clear history favourite', () => {
    expect(chooseSuggestion({ rule: { id: 7, accountGuid: 'sw' }, history: [{ accountGuid: 'x', count: 9 }] })).toEqual({
      accountGuid: 'sw',
      categorizedBy: 'rule:7',
    });
    expect(chooseSuggestion({ rule: null, history: [{ accountGuid: 'a', count: 1 }, { accountGuid: 'b', count: 3 }] })).toEqual({
      accountGuid: 'b',
      categorizedBy: 'history',
    });
  });

  it('abstains on a tie or no history', () => {
    expect(chooseSuggestion({ rule: null, history: [{ accountGuid: 'a', count: 2 }, { accountGuid: 'b', count: 2 }] })).toBeNull();
    expect(chooseSuggestion({ rule: null, history: [] })).toBeNull();
  });
});

describe('approvalBlockers', () => {
  const line = { id: 1, amountCents: 700, expenseAccountGuid: 'sw', accountablePlan: false, missingEvidence: false };

  it('is empty for a fully categorized reimbursement', () => {
    expect(approvalBlockers([line], 'reimburse')).toEqual([]);
  });

  it('lists every blocker', () => {
    const blockers = approvalBlockers(
      [
        { ...line, expenseAccountGuid: null },
        { ...line, id: 2, expenseAccountGuid: null },
        { ...line, id: 3, accountablePlan: true, missingEvidence: true },
      ],
      'contribution',
    );
    expect(blockers).toEqual([
      '2 lines are still uncategorized.',
      '1 line needs a receipt and business purpose (accountable plan).',
      expect.stringMatching(/forfeit the deduction/),
    ]);
    expect(approvalBlockers([], 'reimburse')).toEqual(['The report has no lines.']);
  });
});

describe('transaction plans', () => {
  const lines = [
    { amountCents: 700, expenseAccountGuid: 'sw', description: 'Google Workspace' },
    { amountCents: 12047, expenseAccountGuid: 'supplies', description: 'Golden Needle' },
    { amountCents: 10427, expenseAccountGuid: 'supplies', description: 'Silverliningherbs' },
  ];

  it('summarizes by account', () => {
    expect(summarizeByAccount(lines)).toEqual([
      { accountGuid: 'sw', cents: 700, lines: 1 },
      { accountGuid: 'supplies', cents: 22474, lines: 2 },
    ]);
  });

  it('builds balanced contribution and settlement transactions', () => {
    const business = contributionSplits(lines, 'equity', 'ER-1');
    expect(isBalanced(business)).toBe(true);
    expect(business[business.length - 1]).toEqual({ accountGuid: 'equity', cents: -23174, memo: 'Owner contribution — ER-1' });
    const household = householdSettlementSplits('recv', 'checking', 23174, 'ER-1');
    expect(isBalanced(household)).toBe(true);
    expect(household).toEqual([
      { accountGuid: 'checking', cents: 23174, memo: 'ER-1' },
      { accountGuid: 'recv', cents: -23174, memo: 'ER-1' },
    ]);
  });
});

describe('describeSplitAllocation', () => {
  it('is null for an untouched charge', () => {
    expect(describeSplitAllocation(6222, [])).toBeNull();
  });

  it('describes a fully reported, paid charge', () => {
    expect(
      describeSplitAllocation(6222, [
        { kind: 'business', amountCents: 6222, reportNumber: 3, reportStatus: 'paid', paidOn: '2026-10-05' },
      ]),
    ).toBe('Reported · ER-3 · Paid 2026-10-05');
    expect(
      describeSplitAllocation(6222, [
        { kind: 'business', amountCents: 6222, reportNumber: 3, reportStatus: 'submitted', paidOn: null },
      ]),
    ).toBe('Reported · ER-3 · Submitted');
  });

  it('describes a business/personal split exactly as the spec shows', () => {
    // After marking $22.22 personal the receivable split is $40.00.
    expect(
      describeSplitAllocation(4000, [
        { kind: 'business', amountCents: 4000, reportNumber: 3, reportStatus: 'submitted', paidOn: null },
        { kind: 'personal', amountCents: 2222, reportNumber: null, reportStatus: null, paidOn: null },
      ]),
    ).toBe('$40.00 of $62.22 on ER-3 · $22.22 personal');
  });

  it('shows a partly reported charge across reports', () => {
    expect(
      describeSplitAllocation(6222, [
        { kind: 'business', amountCents: 3000, reportNumber: 3, reportStatus: 'posted', paidOn: null },
        { kind: 'business', amountCents: 1000, reportNumber: 4, reportStatus: 'rejected', paidOn: null },
      ]),
    ).toBe('$30.00 of $62.22 on ER-3 · $32.22 unreported');
  });
});

describe('receivableDifferenceCents', () => {
  it('is zero when the receivable ties out', () => {
    expect(receivableDifferenceCents({ receivableBalanceCents: 209121, unreportedCents: 9121, reportedUnsettledCents: 200000 })).toBe(0);
    expect(receivableDifferenceCents({ receivableBalanceCents: 209121, unreportedCents: 0, reportedUnsettledCents: 200000 })).toBe(9121);
  });
});
