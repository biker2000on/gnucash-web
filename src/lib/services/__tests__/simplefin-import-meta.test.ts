/**
 * Import-time transaction meta: the raw provider payee/description must be
 * preserved in original_description so a later rename of the transaction can
 * never destroy the payee (merchant identity for new-merchant detection,
 * categorization, recurring matching, and dedup).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  default: {},
  generateGuid: vi.fn(() => '0'.repeat(32)),
}));

import {
  buildImportedTransactionMeta,
  importedOriginalDescription,
} from '../simplefin-sync.service';

const TX_GUID = 'a'.repeat(32);

describe('importedOriginalDescription', () => {
  it('prefers the provider description', () => {
    expect(importedOriginalDescription({
      description: 'HARBOR FREIGHT PAYMENT',
      payee: 'Harbor Freight',
    })).toBe('HARBOR FREIGHT PAYMENT');
  });

  it('falls back to the payee when the description is empty', () => {
    expect(importedOriginalDescription({ description: '', payee: 'Harbor Freight' }))
      .toBe('Harbor Freight');
  });

  it('is null when the provider sent neither field', () => {
    expect(importedOriginalDescription({ description: '' })).toBeNull();
  });
});

describe('buildImportedTransactionMeta', () => {
  it('stores the raw provider description as original_description', () => {
    const meta = buildImportedTransactionMeta(
      {
        id: 'sf-txn-1',
        description: 'CALDWELL COUNTY UTILITY~ Future Amount: 29.65 ~ Tran: ACHDW',
        payee: 'Caldwell County Utility',
      },
      TX_GUID,
      'medium',
    );
    expect(meta).toEqual({
      transaction_guid: TX_GUID,
      source: 'simplefin',
      reviewed: false,
      simplefin_transaction_id: 'sf-txn-1',
      confidence: 'medium',
      original_description: 'CALDWELL COUNTY UTILITY~ Future Amount: 29.65 ~ Tran: ACHDW',
    });
  });

  it('imports arrive unreviewed and sourced simplefin (review gate contract)', () => {
    const meta = buildImportedTransactionMeta(
      { id: 'sf-txn-2', description: 'Publix #1548 Boone Nc' },
      TX_GUID,
      'high',
    );
    expect(meta.source).toBe('simplefin');
    expect(meta.reviewed).toBe(false);
  });
});
