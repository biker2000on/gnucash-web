/**
 * Tests for assertPostableAccount cross-book posting guard.
 *
 * Verifies:
 * (a) posting to an account in another book is rejected with InventoryValidationError naming the account and book mismatch
 * (b) posting to an account in the SAME book succeeds
 * (c) placeholder accounts are rejected
 * (d) non-existent accounts are rejected
 * (e) errors map to HTTP 400 in API response helper
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assertPostableAccount, InventoryValidationError } from '../inventory-engine';
import { mapInventoryError } from '../inventory-api-errors';

type TxType = Parameters<typeof assertPostableAccount>[0];

describe('assertPostableAccount cross-book posting guard', () => {
  const mockFindUnique = vi.fn();
  const mockQueryRaw = vi.fn();

  const mockTx = {
    accounts: {
      findUnique: mockFindUnique,
    },
    $queryRaw: mockQueryRaw,
  } as unknown as TxType;

  const CURRENT_BOOK = 'book_11111111111111111111111111111';
  const OTHER_BOOK = 'book_22222222222222222222222222222';
  const ASSET_ACCOUNT = 'acc_asset_1111111111111111111111';
  const OTHER_ASSET_ACCOUNT = 'acc_asset_2222222222222222222222';
  const PLACEHOLDER_ACCOUNT = 'acc_placeholder_11111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects posting to an account belonging to a DIFFERENT book', async () => {
    mockFindUnique.mockResolvedValue({ guid: OTHER_ASSET_ACCOUNT, placeholder: 0 });
    mockQueryRaw.mockResolvedValue([{ book_guid: OTHER_BOOK }]);

    await expect(
      assertPostableAccount(mockTx, CURRENT_BOOK, OTHER_ASSET_ACCOUNT, 'Asset'),
    ).rejects.toThrow(InventoryValidationError);

    await expect(
      assertPostableAccount(mockTx, CURRENT_BOOK, OTHER_ASSET_ACCOUNT, 'Asset'),
    ).rejects.toThrow(/Asset account acc_asset_2222222222222222222222 belongs to book book_22222222222222222222222222222, expected book book_11111111111111111111111111111/);
  });

  it('allows posting to an account belonging to the SAME book', async () => {
    mockFindUnique.mockResolvedValue({ guid: ASSET_ACCOUNT, placeholder: 0 });
    mockQueryRaw.mockResolvedValue([{ book_guid: CURRENT_BOOK }]);

    await expect(
      assertPostableAccount(mockTx, CURRENT_BOOK, ASSET_ACCOUNT, 'Asset'),
    ).resolves.not.toThrow();
  });

  it('rejects placeholder accounts regardless of book', async () => {
    mockFindUnique.mockResolvedValue({ guid: PLACEHOLDER_ACCOUNT, placeholder: 1 });

    await expect(
      assertPostableAccount(mockTx, CURRENT_BOOK, PLACEHOLDER_ACCOUNT, 'Asset'),
    ).rejects.toThrow(InventoryValidationError);

    await expect(
      assertPostableAccount(mockTx, CURRENT_BOOK, PLACEHOLDER_ACCOUNT, 'Asset'),
    ).rejects.toThrow(`Asset account ${PLACEHOLDER_ACCOUNT} is a placeholder`);

    // Must fail before querying book ownership
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('rejects non-existent accounts', async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(
      assertPostableAccount(mockTx, CURRENT_BOOK, 'acc_missing', 'Asset'),
    ).rejects.toThrow(InventoryValidationError);

    await expect(
      assertPostableAccount(mockTx, CURRENT_BOOK, 'acc_missing', 'Asset'),
    ).rejects.toThrow('Asset account not found: acc_missing');

    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('surfaces error with HTTP 400 and clear message via mapInventoryError', async () => {
    mockFindUnique.mockResolvedValue({ guid: OTHER_ASSET_ACCOUNT, placeholder: 0 });
    mockQueryRaw.mockResolvedValue([{ book_guid: OTHER_BOOK }]);

    let caughtError: unknown = null;
    try {
      await assertPostableAccount(mockTx, CURRENT_BOOK, OTHER_ASSET_ACCOUNT, 'Asset');
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(InventoryValidationError);
    const response = mapInventoryError(caughtError);
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Asset account acc_asset_2222222222222222222222 belongs to book book_22222222222222222222222222222, expected book book_11111111111111111111111111111');
  });
});
