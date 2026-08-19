/**
 * SAVE-time validation of an inventory item's ledger posting accounts.
 *
 * The accounts used to be nullable on save and only required at fulfilment —
 * i.e. the misconfiguration surfaced when the invoice was already posted and
 * the user was mid-shipment. They are now required (and validated: in-book,
 * non-placeholder, right account type) the moment the item is saved with
 * ledger posting on, and every failure comes back in ONE error carrying
 * per-field messages. A stock-only item (postToLedger: false) may still leave
 * all three null.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeRawUnsafeMock, queryRawMock, queryRawUnsafeMock } = vi.hoisted(() => ({
  executeRawUnsafeMock: vi.fn(),
  queryRawMock: vi.fn(),
  queryRawUnsafeMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    $executeRawUnsafe: executeRawUnsafeMock,
    $queryRaw: queryRawMock,
    $queryRawUnsafe: queryRawUnsafeMock,
  },
}));
vi.mock('@/lib/redis', () => ({ getRedis: () => null }));

import {
  createItem,
  updateItem,
  validatePostingAccounts,
  InventoryValidationError,
} from '../inventory.service';

const BOOK = 'b'.repeat(32);
const INCOME = 'i'.repeat(32);
const COGS = 'c'.repeat(32);
const ASSET = 'a'.repeat(32);

/** One row as assertPostableAccount's recursive-CTE query returns it. */
function accountRow(overrides: Record<string, unknown> = {}) {
  return {
    guid: 'x',
    account_type: 'ASSET',
    placeholder: 0,
    book_guid: BOOK,
    ...overrides,
  };
}

/** Route the account lookup per guid so each slot can be posed separately. */
function accountsByGuid(byGuid: Record<string, ReturnType<typeof accountRow>>) {
  queryRawMock.mockImplementation((_strings: unknown, guid: string) => {
    const row = byGuid[guid];
    return Promise.resolve(row ? [row] : []);
  });
}

const VALID_ACCOUNTS = {
  [INCOME]: accountRow({ guid: INCOME, account_type: 'INCOME' }),
  [COGS]: accountRow({ guid: COGS, account_type: 'EXPENSE' }),
  [ASSET]: accountRow({ guid: ASSET, account_type: 'ASSET' }),
};

/** The row the INSERT/UPDATE returns; shape mirrors ITEM_COLS. */
function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    book_guid: BOOK,
    sku: 'SKU-1',
    name: 'Widget',
    description: null,
    unit: 'ea',
    sale_price: null,
    income_account_guid: INCOME,
    cogs_account_guid: COGS,
    asset_account_guid: ASSET,
    post_to_ledger: true,
    avg_cost: 0,
    valuation_method: 'average',
    reorder_point: null,
    reorder_quantity: null,
    active: true,
    created_at: new Date('2026-08-19T00:00:00Z'),
    updated_at: new Date('2026-08-19T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  executeRawUnsafeMock.mockReset().mockResolvedValue(0);
  queryRawMock.mockReset();
  queryRawUnsafeMock.mockReset();
  accountsByGuid(VALID_ACCOUNTS);
});

describe('validatePostingAccounts', () => {
  it('accepts three in-book, non-placeholder accounts of the right type', async () => {
    await expect(validatePostingAccounts(BOOK, {
      incomeAccountGuid: INCOME,
      cogsAccountGuid: COGS,
      assetAccountGuid: ASSET,
    })).resolves.toBeUndefined();
  });

  it('reports EVERY missing slot at once, keyed by input field', async () => {
    let thrown: unknown;
    try {
      await validatePostingAccounts(BOOK, {
        incomeAccountGuid: null,
        cogsAccountGuid: undefined,
        assetAccountGuid: '',
      });
    } catch (err) {
      thrown = err;
    }
    const error = thrown as InventoryValidationError;
    expect(error).toBeInstanceOf(InventoryValidationError);
    // One round trip for the user, not three.
    expect(Object.keys(error.fields ?? {}).sort())
      .toEqual(['assetAccountGuid', 'cogsAccountGuid', 'incomeAccountGuid']);
    expect(error.message).toMatch(/ledger posting/i);
  });

  it.each([
    ['a placeholder', { placeholder: 1 }, /placeholder/i],
    ['another book', { book_guid: 'other'.padEnd(32, '0') }, /belongs to book/i],
    ['the wrong account type', { account_type: 'BANK' }, /expected ASSET/],
  ])('rejects an asset slot pointing at %s', async (_label, overrides, pattern) => {
    accountsByGuid({
      ...VALID_ACCOUNTS,
      [ASSET]: accountRow({ guid: ASSET, account_type: 'ASSET', ...overrides }),
    });
    let thrown: unknown;
    try {
      await validatePostingAccounts(BOOK, {
        incomeAccountGuid: INCOME, cogsAccountGuid: COGS, assetAccountGuid: ASSET,
      });
    } catch (err) {
      thrown = err;
    }
    const error = thrown as InventoryValidationError;
    expect(error.fields?.assetAccountGuid).toMatch(pattern);
    // The two good slots are not blamed.
    expect(error.fields?.incomeAccountGuid).toBeUndefined();
    expect(error.fields?.cogsAccountGuid).toBeUndefined();
  });
});

describe('createItem', () => {
  it('refuses to save a posting item with no accounts, and writes nothing', async () => {
    await expect(createItem(BOOK, { sku: 'SKU-1', name: 'Widget' }))
      .rejects.toBeInstanceOf(InventoryValidationError);
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('saves a stock-only item with all three accounts null', async () => {
    queryRawUnsafeMock.mockResolvedValue([itemRow({
      income_account_guid: null,
      cogs_account_guid: null,
      asset_account_guid: null,
      post_to_ledger: false,
    })]);

    const item = await createItem(BOOK, {
      sku: 'SKU-1', name: 'Widget', postToLedger: false,
    });

    expect(item.postToLedger).toBe(false);
    expect(item.cogsAccountGuid).toBeNull();
    // No account lookup happened at all — nothing to validate.
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it('saves a posting item once all three accounts check out', async () => {
    queryRawUnsafeMock.mockResolvedValue([itemRow()]);

    const item = await createItem(BOOK, {
      sku: 'SKU-1',
      name: 'Widget',
      incomeAccountGuid: INCOME,
      cogsAccountGuid: COGS,
      assetAccountGuid: ASSET,
    });

    expect(item.postToLedger).toBe(true);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    const params = queryRawUnsafeMock.mock.calls[0];
    expect(params).toContain(true); // post_to_ledger
  });
});

describe('updateItem', () => {
  /** First $queryRawUnsafe = the existing-row SELECT, second = the UPDATE. */
  function existing(row: Record<string, unknown>) {
    queryRawUnsafeMock
      .mockResolvedValueOnce([itemRow(row)])
      .mockResolvedValueOnce([itemRow({ ...row })]);
  }

  it('refuses to turn posting ON while an account is still empty', async () => {
    existing({ post_to_ledger: false, cogs_account_guid: null });

    let thrown: unknown;
    await updateItem(BOOK, 1, { postToLedger: true }).catch((err) => { thrown = err; });

    const error = thrown as InventoryValidationError;
    expect(error).toBeInstanceOf(InventoryValidationError);
    expect(error.fields?.cogsAccountGuid).toBeDefined();
    // Only the existing-row SELECT ran; the UPDATE never did.
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to CLEAR an account while posting stays on', async () => {
    existing({ post_to_ledger: true });

    let thrown: unknown;
    await updateItem(BOOK, 1, { assetAccountGuid: null }).catch((err) => { thrown = err; });

    expect((thrown as InventoryValidationError).fields?.assetAccountGuid).toBeDefined();
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('allows clearing the accounts together with turning posting off', async () => {
    existing({ post_to_ledger: true });

    await expect(updateItem(BOOK, 1, {
      postToLedger: false,
      incomeAccountGuid: null,
      cogsAccountGuid: null,
      assetAccountGuid: null,
    })).resolves.toBeDefined();
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
  });

  it('leaves an edit that does not touch posting alone', async () => {
    // A posting item whose asset account was deleted in GnuCash must still be
    // renameable and deactivatable — otherwise the misconfiguration locks the
    // row. The moment the user edits the posting setup, the full check is back.
    existing({ post_to_ledger: true });
    accountsByGuid({}); // every lookup would fail if it ran

    await expect(updateItem(BOOK, 1, { name: 'Renamed' })).resolves.toBeDefined();
    expect(queryRawMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
  });
});
