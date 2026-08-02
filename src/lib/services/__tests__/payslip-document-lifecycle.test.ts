import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  raw: vi.fn(),
  payslipUpdate: vi.fn(),
  metaFind: vi.fn(),
  metaUpdate: vi.fn(),
  upsertTemplate: vi.fn(),
  getBySource: vi.fn(),
  link: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: {
  $queryRaw: mocks.raw,
  gnucash_web_payslips: { update: mocks.payslipUpdate },
  gnucash_web_transaction_meta: {
    findUnique: mocks.metaFind,
    update: mocks.metaUpdate,
    create: vi.fn(),
  },
} }));
vi.mock('@/lib/payslips', () => ({ upsertTemplate: mocks.upsertTemplate }));
vi.mock('@/lib/services/period-lock.service', () => ({
  assertNotLocked: vi.fn(),
  assertTxnMutable: vi.fn(),
}));
vi.mock('@/lib/documents', () => ({
  getDocumentBySource: mocks.getBySource,
  linkDocument: mocks.link,
}));

import { postPayslipTransaction } from '../payslip-post.service';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.raw
    .mockResolvedValueOnce([]) // no SimpleFin match
    .mockResolvedValueOnce([{ guid: 'tx-existing', split_count: 2 }])
    .mockResolvedValueOnce([
      { account_guid: 'income', amount: -100 },
      { account_guid: 'bank', amount: 100 },
    ]);
  mocks.metaFind.mockResolvedValue({ transaction_guid: 'tx-existing' });
  mocks.getBySource.mockResolvedValue({ id: 81 });
});

describe('payslip transaction evidence link', () => {
  it('links the canonical payslip after an existing transaction is posted', async () => {
    const guid = await postPayslipTransaction(
      6,
      'book-1',
      'usd',
      [{ category: 'earnings', label: 'Pay', normalized_label: 'pay', amount: 100 }],
      { 'earnings:pay': 'income' },
      'bank',
      100,
      '2026-08-01',
      'Acme',
    );

    expect(guid).toBe('tx-existing');
    expect(mocks.link).toHaveBeenCalledWith({
      bookGuid: 'book-1',
      documentId: 81,
      targetType: 'transaction',
      targetId: 'tx-existing',
      role: 'payslip',
      metadata: { autoSource: 'gnucash_web_payslips.transaction_guid' },
    });
  });

  it('returns the committed transaction when the canonical link fails', async () => {
    mocks.link.mockRejectedValueOnce(new Error('canonical database unavailable'));

    const guid = await postPayslipTransaction(
      6,
      'book-1',
      'usd',
      [{ category: 'earnings', label: 'Pay', normalized_label: 'pay', amount: 100 }],
      { 'earnings:pay': 'income' },
      'bank',
      100,
      '2026-08-01',
      'Acme',
    );

    expect(guid).toBe('tx-existing');
    expect(mocks.payslipUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'posted', transaction_guid: 'tx-existing' }),
    }));
  });
});
