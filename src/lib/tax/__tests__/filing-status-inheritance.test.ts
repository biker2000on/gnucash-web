import { describe, expect, it } from 'vitest';
import {
  applyFilingStatusSelection,
  filingStatusOverrideToPersist,
  normalizeFilingStatus,
  resolveFilingStatus,
} from '../filing-status-inheritance';
import { computeFederalTax, emptyFederalInputs } from '../federal';

describe('normalizeFilingStatus', () => {
  it('accepts every valid filing status', () => {
    for (const fs of ['single', 'mfj', 'mfs', 'hoh', 'qss'] as const) {
      expect(normalizeFilingStatus(fs)).toBe(fs);
    }
  });

  it('rejects garbage, null, undefined, and non-strings', () => {
    expect(normalizeFilingStatus('married')).toBeNull();
    expect(normalizeFilingStatus('')).toBeNull();
    expect(normalizeFilingStatus(null)).toBeNull();
    expect(normalizeFilingStatus(undefined)).toBeNull();
    expect(normalizeFilingStatus(42)).toBeNull();
  });
});

describe('resolveFilingStatus — seeding from the household profile', () => {
  it('inherits the household value when no local value is stored', () => {
    const r = resolveFilingStatus(undefined, 'mfj');
    expect(r).toEqual({ effective: 'mfj', source: 'household', divergesFromHousehold: false });
  });

  it('falls back to the default when neither is set', () => {
    const r = resolveFilingStatus(undefined, null);
    expect(r).toEqual({ effective: 'single', source: 'default', divergesFromHousehold: false });
  });

  it('uses a caller-provided fallback', () => {
    expect(resolveFilingStatus(null, null, 'hoh').effective).toBe('hoh');
  });

  it('treats an invalid stored value as absent (inherits)', () => {
    const r = resolveFilingStatus('bogus', 'mfs');
    expect(r).toEqual({ effective: 'mfs', source: 'household', divergesFromHousehold: false });
  });

  it('treats an invalid household value as unset', () => {
    const r = resolveFilingStatus(undefined, 'not-a-status');
    expect(r.source).toBe('default');
  });
});

describe('resolveFilingStatus — inherited vs override state', () => {
  it('a stored value EQUAL to the household profile is inherited, not an override', () => {
    const r = resolveFilingStatus('mfj', 'mfj');
    expect(r).toEqual({ effective: 'mfj', source: 'household', divergesFromHousehold: false });
  });

  it('a stored value that DIFFERS from the profile is an override and flags divergence', () => {
    const r = resolveFilingStatus('mfs', 'mfj');
    expect(r).toEqual({ effective: 'mfs', source: 'override', divergesFromHousehold: true });
  });

  it('a stored value with no household profile stands alone without divergence', () => {
    const r = resolveFilingStatus('hoh', null);
    expect(r).toEqual({ effective: 'hoh', source: 'override', divergesFromHousehold: false });
  });
});

describe('applyFilingStatusSelection', () => {
  it('selecting the household value returns to inherited state (null)', () => {
    expect(applyFilingStatusSelection('mfj', 'mfj')).toBeNull();
  });

  it('selecting a different value is an explicit override', () => {
    expect(applyFilingStatusSelection('mfs', 'mfj')).toBe('mfs');
  });

  it('with no household setting, any selection is kept', () => {
    expect(applyFilingStatusSelection('single', null)).toBe('single');
  });
});

describe('filingStatusOverrideToPersist — no redundant persistence for inherited state', () => {
  it('persists nothing when the local value matches the household profile', () => {
    expect(filingStatusOverrideToPersist('mfj', 'mfj')).toBeUndefined();
  });

  it('persists a true override', () => {
    expect(filingStatusOverrideToPersist('mfs', 'mfj')).toBe('mfs');
  });

  it('persists the local value when the household profile is unset', () => {
    expect(filingStatusOverrideToPersist('hoh', null)).toBe('hoh');
  });
});

describe('engines receive the resolved value', () => {
  it('computeFederalTax runs on the override, not the household value', () => {
    const resolution = resolveFilingStatus('mfs', 'mfj');
    const overridden = computeFederalTax({
      ...emptyFederalInputs(2026, resolution.effective),
      wages: 100_000,
    });
    const inherited = computeFederalTax({
      ...emptyFederalInputs(2026, 'mfj'),
      wages: 100_000,
    });
    // MFS standard deduction is half the MFJ one — proof the engine saw the
    // override rather than the household setting.
    expect(overridden.standardDeduction).toBeLessThan(inherited.standardDeduction);
    expect(overridden.standardDeduction * 2).toBeCloseTo(inherited.standardDeduction, 2);
  });

  it('computeFederalTax runs on the inherited household value when no override exists', () => {
    const resolution = resolveFilingStatus(undefined, 'mfj');
    const result = computeFederalTax({
      ...emptyFederalInputs(2026, resolution.effective),
      wages: 100_000,
    });
    const explicitMfj = computeFederalTax({
      ...emptyFederalInputs(2026, 'mfj'),
      wages: 100_000,
    });
    expect(result.totalTax).toBe(explicitMfj.totalTax);
  });
});
