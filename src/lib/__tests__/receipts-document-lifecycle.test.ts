import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getBySource: vi.fn(),
  remove: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('../db', () => ({ query: mocks.query }));
vi.mock('../documents', () => ({
  getDocumentBySource: mocks.getBySource,
  deleteDocumentBySource: mocks.remove,
  linkDocument: mocks.link,
  unlinkDocument: mocks.unlink,
}));

import { deleteReceipt, linkReceipt } from '../receipts';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBySource.mockResolvedValue({ id: 70 });
  mocks.remove.mockResolvedValue(true);
});

describe('receipt canonical lifecycle', () => {
  it('removes the canonical source after deleting an owned receipt', async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] });
    await expect(deleteReceipt(7, 'book-1')).resolves.toBe(true);
    expect(mocks.remove).toHaveBeenCalledWith('book-1', 'receipt', '7');
    expect(mocks.query.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.remove.mock.invocationCallOrder[0],
    );

    mocks.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteReceipt(8, 'book-1')).resolves.toBe(false);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });

  it('keeps authoritative delete success when canonical cleanup fails', async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] });
    mocks.remove.mockRejectedValueOnce(new Error('canonical database unavailable'));

    await expect(deleteReceipt(7, 'book-1')).resolves.toBe(true);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('does not remove canonical links when authoritative deletion fails', async () => {
    mocks.query.mockRejectedValueOnce(new Error('receipt delete failed'));

    await expect(deleteReceipt(7, 'book-1')).rejects.toThrow('receipt delete failed');
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('replaces the prior transaction evidence edge when relinked', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ transaction_guid: 'tx-old' }] })
      .mockResolvedValueOnce({ rows: [{ id: 7, transaction_guid: 'tx-new' }] });

    await linkReceipt(7, 'book-1', 'tx-new');

    expect(mocks.unlink).toHaveBeenCalledWith({
      bookGuid: 'book-1', documentId: 70, targetType: 'transaction',
      targetId: 'tx-old', role: 'receipt',
    });
    expect(mocks.link).toHaveBeenCalledWith({
      bookGuid: 'book-1', documentId: 70, targetType: 'transaction',
      targetId: 'tx-new', role: 'receipt',
      metadata: { autoSource: 'gnucash_web_receipts.transaction_guid' },
    });
  });

  it('returns the updated receipt when canonical relinking fails', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ transaction_guid: 'tx-old' }] })
      .mockResolvedValueOnce({ rows: [{ id: 7, transaction_guid: 'tx-new' }] });
    mocks.unlink.mockRejectedValueOnce(new Error('canonical database unavailable'));
    mocks.link.mockRejectedValueOnce(new Error('canonical database unavailable'));

    await expect(linkReceipt(7, 'book-1', 'tx-new')).resolves.toMatchObject({
      id: 7,
      transaction_guid: 'tx-new',
    });
    expect(mocks.link).toHaveBeenCalledOnce();
  });

  it('removes the old edge and adds none when unlinked', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ transaction_guid: 'tx-old' }] })
      .mockResolvedValueOnce({ rows: [{ id: 7, transaction_guid: null }] });
    await linkReceipt(7, 'book-1', null);
    expect(mocks.unlink).toHaveBeenCalledOnce();
    expect(mocks.link).not.toHaveBeenCalled();
  });
});
