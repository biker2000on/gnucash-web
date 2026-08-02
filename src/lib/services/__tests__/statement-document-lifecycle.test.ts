import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  raw: vi.fn(),
  executeUnsafe: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  getBySource: vi.fn(),
  remove: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: {
  $queryRawUnsafe: mocks.raw,
  $executeRawUnsafe: mocks.executeUnsafe,
  $executeRaw: mocks.execute,
  $transaction: mocks.transaction,
} }));
vi.mock('@/lib/documents', () => ({
  getDocumentBySource: mocks.getBySource,
  deleteDocumentBySource: mocks.remove,
  linkDocument: mocks.link,
  unlinkDocument: mocks.unlink,
}));

import { deleteBatch, setBatchStatus } from '../statement.service';

const row = (accountGuid: string | null) => ({
  id: 4, book_guid: 'book-1', account_guid: accountGuid, source: 'pdf',
  original_filename: 'statement.pdf', storage_key: 'statement/4.pdf',
  thumbnail_key: null, status: 'parsed', statement_start_date: null,
  statement_end_date: null, opening_balance: null, closing_balance: null,
  currency: 'USD', ofx_acct_id: null, error: null,
  created_at: new Date(), updated_at: new Date(),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeUnsafe.mockResolvedValue(0);
  mocks.execute.mockResolvedValue(1);
  mocks.transaction.mockImplementation(async (callback) => callback({ $executeRaw: mocks.execute }));
  mocks.getBySource.mockResolvedValue({ id: 90 });
  mocks.remove.mockResolvedValue(true);
});

describe('statement canonical lifecycle', () => {
  it('replaces the account edge when a batch is reassigned', async () => {
    mocks.raw
      .mockResolvedValueOnce([row('acct-old')])
      .mockResolvedValueOnce([row('acct-new')]);
    await setBatchStatus(4, 'parsed', { accountGuid: 'acct-new' });
    expect(mocks.unlink).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 90, targetId: 'acct-old', role: 'statement',
    }));
    expect(mocks.link).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 90, targetId: 'acct-new', role: 'statement',
      metadata: { autoSource: 'gnucash_web_statement_batches.account_guid' },
    }));
  });

  it('removes the canonical row after atomically deleting the batch and lines', async () => {
    mocks.raw.mockResolvedValueOnce([row('acct-old')]);
    await deleteBatch(4);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.remove).toHaveBeenCalledWith('book-1', 'statement_batch', '4');
    expect(mocks.execute.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.remove.mock.invocationCallOrder[0],
    );
  });

  it('keeps authoritative delete success when canonical cleanup fails', async () => {
    mocks.raw.mockResolvedValueOnce([row('acct-old')]);
    mocks.remove.mockRejectedValueOnce(new Error('canonical database unavailable'));

    await expect(deleteBatch(4)).resolves.toBeUndefined();
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });

  it('does not remove canonical links when the authoritative transaction fails', async () => {
    mocks.raw.mockResolvedValueOnce([row('acct-old')]);
    mocks.execute
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('batch delete failed'));

    await expect(deleteBatch(4)).rejects.toThrow('batch delete failed');
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('returns the reassigned batch when canonical edge updates fail', async () => {
    mocks.raw
      .mockResolvedValueOnce([row('acct-old')])
      .mockResolvedValueOnce([row('acct-new')]);
    mocks.unlink.mockRejectedValueOnce(new Error('unlink unavailable'));
    mocks.link.mockRejectedValueOnce(new Error('link unavailable'));

    await expect(setBatchStatus(4, 'parsed', { accountGuid: 'acct-new' }))
      .resolves.toMatchObject({ accountGuid: 'acct-new' });
    expect(mocks.link).toHaveBeenCalledOnce();
  });
});
