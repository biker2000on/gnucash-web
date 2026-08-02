import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  rawQuery,
  accountGuids,
  taxFindUnique,
  taxFindMany,
  taxCreate,
  taxUpdate,
  filingFindMany,
} = vi.hoisted(() => ({
  rawQuery: vi.fn(),
  accountGuids: vi.fn(),
  taxFindUnique: vi.fn(),
  taxFindMany: vi.fn(),
  taxCreate: vi.fn(),
  taxUpdate: vi.fn(),
  filingFindMany: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    $queryRaw: rawQuery,
    gnucash_web_vendor_tax_info: {
      findUnique: taxFindUnique,
      findMany: taxFindMany,
      create: taxCreate,
      update: taxUpdate,
    },
    gnucash_web_vendor_1099_filings: { findMany: filingFindMany },
  },
}));
vi.mock('@/lib/book-scope', () => ({ getAccountGuidsForBook: accountGuids }));

import {
  assertVendor1099BookScope,
  get1099Summary,
  upsertVendorTaxInfo,
  Vendor1099NotFoundError,
} from '../vendor-1099.service';

const BOOK = 'book-1';
const VENDOR = 'a'.repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
  taxFindMany.mockResolvedValue([]);
  filingFindMany.mockResolvedValue([]);
});

describe('assertVendor1099BookScope', () => {
  it('rejects before querying vendors when the book owns no accounts', async () => {
    accountGuids.mockResolvedValue([]);

    await expect(assertVendor1099BookScope(BOOK, VENDOR)).rejects.toBeInstanceOf(Vendor1099NotFoundError);
    expect(rawQuery).not.toHaveBeenCalled();
  });

  it('rejects a vendor that exists globally but has no posted bill in this book', async () => {
    accountGuids.mockResolvedValue(['account-in-book']);
    rawQuery.mockResolvedValue([]);

    await expect(assertVendor1099BookScope(BOOK, VENDOR)).rejects.toThrow('Vendor not found in this book');
    expect(accountGuids).toHaveBeenCalledWith(BOOK);
    expect(rawQuery).toHaveBeenCalledTimes(1);
  });

  it('allows a vendor proven by a posted bill in the current book', async () => {
    accountGuids.mockResolvedValue(['account-in-book']);
    rawQuery.mockResolvedValue([{ guid: VENDOR }]);

    await expect(assertVendor1099BookScope(BOOK, VENDOR)).resolves.toBeUndefined();
  });
});

describe('book-scoped vendor tax metadata', () => {
  it('rejects a globally valid vendor before reading or overwriting another book tax row', async () => {
    accountGuids.mockResolvedValue(['account-in-book']);
    rawQuery.mockResolvedValue([{ guid: VENDOR }]);
    taxFindUnique.mockResolvedValue({ book_guid: 'other-book' });

    await expect(upsertVendorTaxInfo(BOOK, VENDOR, {
      taxClassification: 'llc',
      tinLast4: '1234',
    })).rejects.toThrow('Vendor tax info not found in this book');

    expect(taxFindUnique).toHaveBeenCalledTimes(1);
    expect(taxFindUnique).toHaveBeenCalledWith({
      where: { vendor_guid: VENDOR },
      select: { book_guid: true },
    });
    expect(taxUpdate).not.toHaveBeenCalled();
    expect(taxCreate).not.toHaveBeenCalled();
  });

  it('updates only metadata already owned by the active book without rewriting ownership', async () => {
    accountGuids.mockResolvedValue(['account-in-book']);
    rawQuery.mockResolvedValue([{ guid: VENDOR }]);
    taxFindUnique
      .mockResolvedValueOnce({ book_guid: BOOK })
      .mockResolvedValueOnce({ tax_classification: 'llc', tax_id_masked: '**-***9876' });
    taxUpdate.mockResolvedValue({
      vendor_guid: VENDOR,
      book_guid: BOOK,
      legal_name: 'Scoped Vendor LLC',
      tax_classification: 'llc',
      tax_id_masked: '**-***9876',
      w9_received: true,
      w9_received_date: null,
      w9_requested_date: null,
      exempt_from_1099: false,
      address: null,
      notes: null,
    });

    await expect(upsertVendorTaxInfo(BOOK, VENDOR, {
      legalName: 'Scoped Vendor LLC',
      w9Received: true,
    })).resolves.toMatchObject({ legalName: 'Scoped Vendor LLC', w9Received: true });

    const update = taxUpdate.mock.calls[0][0];
    expect(update.where).toEqual({ vendor_guid: VENDOR });
    expect(update.data).not.toHaveProperty('book_guid');
    expect(taxCreate).not.toHaveBeenCalled();
  });

  it('book-scopes tax and filing metadata reads in the summary path', async () => {
    rawQuery
      .mockResolvedValueOnce([{ guid: VENDOR, name: 'Vendor', active: 1 }])
      .mockResolvedValueOnce([]);

    await get1099Summary(BOOK, ['account-in-book'], 2025);

    expect(taxFindMany).toHaveBeenCalledWith({
      where: { vendor_guid: { in: [VENDOR] }, book_guid: BOOK },
    });
    expect(filingFindMany).toHaveBeenCalledWith({
      where: { vendor_guid: { in: [VENDOR] }, tax_year: 2025, book_guid: BOOK },
    });
  });
});
