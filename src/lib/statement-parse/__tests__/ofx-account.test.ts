import { describe, it, expect } from 'vitest';
import {
  normalizeOfxAcctId,
  planOfxAccountActions,
  OFX_ACCT_ID_MAX_LENGTH,
} from '../ofx-account';

describe('normalizeOfxAcctId', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeOfxAcctId('  123456789  ')).toBe('123456789');
    expect(normalizeOfxAcctId('12 34\t56')).toBe('12 34 56');
  });

  it('returns null for missing / empty values', () => {
    expect(normalizeOfxAcctId(null)).toBeNull();
    expect(normalizeOfxAcctId(undefined)).toBeNull();
    expect(normalizeOfxAcctId('')).toBeNull();
    expect(normalizeOfxAcctId('   ')).toBeNull();
  });

  it('preserves case and separators (distinct accounts must not merge)', () => {
    expect(normalizeOfxAcctId('4111-XXXX-1234')).toBe('4111-XXXX-1234');
    expect(normalizeOfxAcctId('abcDEF')).toBe('abcDEF');
  });

  it('truncates to the column limit', () => {
    const long = 'x'.repeat(100);
    expect(normalizeOfxAcctId(long)).toHaveLength(OFX_ACCT_ID_MAX_LENGTH);
  });
});

describe('planOfxAccountActions', () => {
  it('does nothing when the file has no ACCTID', () => {
    expect(
      planOfxAccountActions({
        rawAcctId: null,
        batchAccountGuid: 'acct-1',
        mappedAccountGuid: 'acct-2',
      }),
    ).toEqual({ ofxAcctId: null, rememberAccountGuid: null, assignAccountGuid: null });
  });

  it('remembers the pairing when the batch already has an account', () => {
    expect(
      planOfxAccountActions({
        rawAcctId: ' 123456789 ',
        batchAccountGuid: 'acct-1',
        mappedAccountGuid: null,
      }),
    ).toEqual({
      ofxAcctId: '123456789',
      rememberAccountGuid: 'acct-1',
      assignAccountGuid: null,
    });
  });

  it('prefers the batch account over a stale mapping (upload wins, map refreshed)', () => {
    const plan = planOfxAccountActions({
      rawAcctId: '123456789',
      batchAccountGuid: 'acct-new',
      mappedAccountGuid: 'acct-old',
    });
    expect(plan.rememberAccountGuid).toBe('acct-new');
    expect(plan.assignAccountGuid).toBeNull();
  });

  it('auto-assigns from the map when the batch lacks an account', () => {
    expect(
      planOfxAccountActions({
        rawAcctId: '123456789',
        batchAccountGuid: null,
        mappedAccountGuid: 'acct-mapped',
      }),
    ).toEqual({
      ofxAcctId: '123456789',
      rememberAccountGuid: null,
      assignAccountGuid: 'acct-mapped',
    });
  });

  it('stores the id but takes no action when unmapped and unassigned', () => {
    expect(
      planOfxAccountActions({
        rawAcctId: '123456789',
        batchAccountGuid: null,
        mappedAccountGuid: null,
      }),
    ).toEqual({ ofxAcctId: '123456789', rememberAccountGuid: null, assignAccountGuid: null });
  });
});
