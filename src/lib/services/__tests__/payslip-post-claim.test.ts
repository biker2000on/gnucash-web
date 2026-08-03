/**
 * Posting a payslip twice writes gross pay, every withholding, the 401k
 * deferral and the net deposit twice — and nothing detects it afterwards.
 * These tests pin the claim-first guard that prevents it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  raw: vi.fn(),
  executeRaw: vi.fn(),
  payslipUpdate: vi.fn(),
  metaCreate: vi.fn(),
  upsertTemplate: vi.fn(),
  getBySource: vi.fn(),
  link: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const client = {
    $queryRaw: mocks.raw,
    $executeRaw: mocks.executeRaw,
    gnucash_web_payslips: { update: mocks.payslipUpdate },
    gnucash_web_transaction_meta: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: mocks.metaCreate,
    },
    $transaction: (fn: (tx: unknown) => unknown) => mocks.transaction(fn, client),
  };
  return { default: client };
});
vi.mock('@/lib/payslips', () => ({ upsertTemplate: mocks.upsertTemplate }));
vi.mock('@/lib/services/period-lock.service', () => ({
  assertNotLocked: vi.fn(),
  assertTxnMutable: vi.fn(),
}));
vi.mock('@/lib/documents', () => ({
  getDocumentBySource: mocks.getBySource,
  linkDocument: mocks.link,
}));

import {
  PayslipPostConflictError,
  postPayslipTransaction,
} from '../payslip-post.service';

const LINE_ITEMS = [
  { category: 'earnings' as const, label: 'Pay', normalized_label: 'pay', amount: 100 },
];

function post() {
  return postPayslipTransaction(
    6,
    'book-1',
    'usd',
    LINE_ITEMS,
    { 'earnings:pay': 'income' },
    'bank',
    100,
    '2026-08-01',
    'Acme',
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation((fn, client) => fn(client));
  mocks.getBySource.mockResolvedValue(null);
});

describe('payslip posting claim', () => {
  it('claims the row with a conditional UPDATE before touching the ledger', async () => {
    mocks.raw
      .mockResolvedValueOnce([{ prior_status: 'ready' }]) // claim
      .mockResolvedValueOnce([]) // no SimpleFin match
      .mockResolvedValueOnce([]); // no matching transaction

    await post();

    const claimSql = String(mocks.raw.mock.calls[0][0]);
    expect(claimSql).toContain('UPDATE gnucash_web_payslips');
    expect(claimSql).toContain("SET status = 'posting'");
    expect(claimSql).toContain("status <> 'posted'");
    // FOR UPDATE serializes concurrent claims so the loser re-reads 'posting'.
    expect(claimSql).toContain('FOR UPDATE');
    // The claim must be the FIRST database statement of the post.
    expect(mocks.raw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.executeRaw.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it('aborts without writing anything when the claim returns no row', async () => {
    mocks.raw.mockResolvedValueOnce([]); // already posted / already posting

    await expect(post()).rejects.toBeInstanceOf(PayslipPostConflictError);

    // Nothing else ran: no ledger insert, no payslip update, no template write.
    expect(mocks.executeRaw).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.payslipUpdate).not.toHaveBeenCalled();
    expect(mocks.upsertTemplate).not.toHaveBeenCalled();
  });

  it('allows a stale claim to be taken over so a crash cannot wedge the payslip', async () => {
    mocks.raw
      .mockResolvedValueOnce([{ prior_status: 'ready' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await post();

    const claimSql = String(mocks.raw.mock.calls[0][0]);
    expect(claimSql).toContain("status <> 'posting' OR updated_at IS NULL OR updated_at <");
  });

  it('hands the claim back when the posting transaction fails', async () => {
    mocks.raw
      .mockResolvedValueOnce([{ prior_status: 'needs_mapping' }])
      .mockResolvedValueOnce([]);
    const boom = new Error('deadlock detected');
    mocks.transaction.mockRejectedValueOnce(boom);

    await expect(post()).rejects.toBe(boom);

    const release = mocks.executeRaw.mock.calls.at(-1);
    expect(String(release?.[0])).toContain('UPDATE gnucash_web_payslips');
    // Restores the prior status, and only from 'posting' so it can never
    // clobber a status written by a successful post.
    expect(release).toContain('needs_mapping');
    expect(String(release?.[0])).toContain("status = 'posting'");
  });

  it('runs the duplicate scan inside the posting transaction', async () => {
    mocks.raw
      .mockResolvedValueOnce([{ prior_status: 'ready' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await post();

    // The dedup candidate query must be issued from within $transaction, not
    // before it (invoice-engine's payment idempotency does the same).
    const txCallOrder = mocks.transaction.mock.invocationCallOrder[0];
    const dedupCallOrder = mocks.raw.mock.invocationCallOrder[2];
    expect(dedupCallOrder).toBeGreaterThan(txCallOrder);
  });

  it('passes the transaction client to upsertTemplate so it cannot escape', async () => {
    mocks.raw
      .mockResolvedValueOnce([{ prior_status: 'ready' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await post();

    expect(mocks.upsertTemplate).toHaveBeenCalledTimes(1);
    // 4th argument is the tx client — without it the template write commits on
    // a second pooled connection and survives a rollback.
    expect(mocks.upsertTemplate.mock.calls[0][3]).toBeDefined();
  });
});
