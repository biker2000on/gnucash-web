import { describe, expect, it } from 'vitest';
import {
  affectedTaxYears,
  coerceLegacyEntityType,
  comparisonYearRange,
  describeStatus,
  describeAffectedYears,
  electionStatutoryDueDate,
  formatYearRanges,
  INCEPTION_DATE,
  fromLegacyEntityType,
  isIsoDate,
  isMidYear,
  LEGAL_FORMS,
  legacyEntityType,
  resolveStatusAt,
  resolveTaxYear,
  statusPairError,
  statusRowFlags,
  VALID_CLASSIFICATIONS,
  type EntityStatusRow,
} from '@/lib/entity-status';
import type { EntityType } from '@/lib/services/entity.service';

function row(partial: Partial<EntityStatusRow> & { effectiveFrom: string }): EntityStatusRow {
  return {
    id: null,
    legalForm: 'llc_single_member',
    taxClassification: 'disregarded',
    electionForm: null,
    electionFiledOn: null,
    electionAcceptedOn: null,
    shortYearConfirmed: false,
    electionDocumentId: null,
    acceptanceDocumentId: null,
    notes: null,
    ...partial,
  };
}

const LLC = row({ id: 1, effectiveFrom: '2026-03-01' });
const S_ELECTION = row({
  id: 2,
  effectiveFrom: '2027-01-01',
  taxClassification: 's_corp',
  electionForm: '2553',
});

describe('legacy entity type mapping', () => {
  const ALL: EntityType[] = [
    'household',
    'sole_prop',
    'llc_single',
    'llc_partnership',
    's_corp',
    'c_corp',
    'nonprofit_501c3',
  ];

  it('round-trips every legacy type', () => {
    for (const t of ALL) {
      const { legalForm, taxClassification } = fromLegacyEntityType(t);
      expect(statusPairError(legalForm, taxClassification)).toBeNull();
      expect(legacyEntityType(legalForm, taxClassification)).toBe(t);
    }
  });

  it('maps an LLC with an S election to s_corp', () => {
    expect(legacyEntityType('llc_single_member', 's_corp')).toBe('s_corp');
    expect(legacyEntityType('llc_multi_member', 'c_corp')).toBe('c_corp');
  });

  it('keeps a compatible legal form when coercing a legacy type', () => {
    expect(coerceLegacyEntityType({ legalForm: 'llc_single_member' }, 's_corp')).toEqual({
      legalForm: 'llc_single_member',
      taxClassification: 's_corp',
    });
    // sole_prop cannot be an S-corp → falls back to the default mapping
    expect(coerceLegacyEntityType({ legalForm: 'sole_prop' }, 's_corp')).toEqual({
      legalForm: 'corporation',
      taxClassification: 's_corp',
    });
    // disregarded on an LLC must not become sole_prop's legacy value
    expect(coerceLegacyEntityType({ legalForm: 'llc_single_member' }, 'sole_prop')).toEqual({
      legalForm: 'sole_prop',
      taxClassification: 'disregarded',
    });
    expect(coerceLegacyEntityType(null, 'llc_single')).toEqual({
      legalForm: 'llc_single_member',
      taxClassification: 'disregarded',
    });
  });
});

describe('statusPairError', () => {
  it('rejects impossible pairs', () => {
    expect(statusPairError('sole_prop', 's_corp')).toMatch(/cannot be taxed/);
    expect(statusPairError('llc_multi_member', 'disregarded')).toMatch(/cannot be taxed/);
    expect(statusPairError('household', 'c_corp')).not.toBeNull();
  });

  it('accepts every declared valid pair', () => {
    for (const form of LEGAL_FORMS) {
      for (const cls of VALID_CLASSIFICATIONS[form]) {
        expect(statusPairError(form, cls)).toBeNull();
      }
    }
  });
});

describe('resolveStatusAt', () => {
  it('returns null with no history', () => {
    expect(resolveStatusAt([], '2026-01-01')).toBeNull();
  });

  it('applies the earliest row since inception', () => {
    expect(resolveStatusAt([LLC, S_ELECTION], '2020-06-01')).toBe(LLC);
  });

  it('switches on the effective date, not before', () => {
    expect(resolveStatusAt([S_ELECTION, LLC], '2026-12-31')).toBe(LLC);
    expect(resolveStatusAt([S_ELECTION, LLC], '2027-01-01')).toBe(S_ELECTION);
    expect(resolveStatusAt([S_ELECTION, LLC], '2030-05-05')).toBe(S_ELECTION);
  });
});

describe('resolveTaxYear', () => {
  it('treats a January 1 election as a clean year boundary', () => {
    const y2026 = resolveTaxYear([LLC, S_ELECTION], 2026);
    expect(y2026.status).toBe(LLC);
    expect(y2026.mixed).toBe(false);
    const y2027 = resolveTaxYear([LLC, S_ELECTION], 2027);
    expect(y2027.status).toBe(S_ELECTION);
    expect(y2027.mixed).toBe(false);
    expect(y2027.segments).toEqual([{ from: '2027-01-01', to: '2027-12-31', row: S_ELECTION }]);
  });

  it('splits a mid-year change into short-year segments', () => {
    const mid = row({ id: 3, effectiveFrom: '2027-07-01', taxClassification: 'c_corp' });
    const y = resolveTaxYear([LLC, mid], 2027);
    expect(y.mixed).toBe(true);
    expect(y.shortYearConfirmed).toBe(false);
    expect(y.status).toBe(mid);
    expect(y.segments.map((s) => [s.from, s.to])).toEqual([
      ['2027-01-01', '2027-06-30'],
      ['2027-07-01', '2027-12-31'],
    ]);
    const confirmed = resolveTaxYear([LLC, { ...mid, shortYearConfirmed: true }], 2027);
    expect(confirmed.shortYearConfirmed).toBe(true);
  });

  it('merges rows that do not change the treatment', () => {
    const acceptance = row({ id: 4, effectiveFrom: '2026-08-01' });
    const y = resolveTaxYear([LLC, acceptance], 2026);
    expect(y.mixed).toBe(false);
    expect(y.segments).toHaveLength(1);
  });

  it('handles an empty history', () => {
    expect(resolveTaxYear([], 2026)).toMatchObject({ status: null, segments: [], mixed: false });
  });
});

describe('affectedTaxYears', () => {
  it('reports only the years whose treatment changes', () => {
    expect(affectedTaxYears([LLC], [LLC, S_ELECTION], 2020, 2030)).toEqual([
      2027, 2028, 2029, 2030,
    ]);
  });

  it('reports nothing for a no-op edit', () => {
    expect(affectedTaxYears([LLC], [{ ...LLC, notes: 'x' }], 2020, 2030)).toEqual([]);
  });

  it('catches a correction to the since-inception row', () => {
    const corrected = { ...LLC, taxClassification: 's_corp' as const };
    const years = affectedTaxYears([LLC, S_ELECTION], [corrected, S_ELECTION], 2024, 2028);
    expect(years).toEqual([2024, 2025, 2026]);
  });

  it('ignores the inception sentinel when choosing the comparison range', () => {
    const seed = row({ id: 9, effectiveFrom: INCEPTION_DATE });
    expect(comparisonYearRange([seed, S_ELECTION], '2026-09-30')).toEqual({
      fromYear: 2016,
      toYear: 2028,
    });
    expect(resolveStatusAt([seed, S_ELECTION], '1850-01-01')).toBe(seed);
  });

  it('computes a comparison range covering future elections', () => {
    expect(comparisonYearRange([LLC, S_ELECTION], '2026-09-30')).toEqual({
      fromYear: 2016,
      toYear: 2028,
    });
  });
});

describe('statusRowFlags', () => {
  it('flags a future election as planned', () => {
    expect(statusRowFlags(S_ELECTION, '2026-09-30')).toEqual({
      future: true,
      awaitingAcceptance: true,
      planned: true,
    });
  });

  it('keeps a past election planned until acceptance is recorded', () => {
    expect(statusRowFlags(S_ELECTION, '2027-02-01').planned).toBe(true);
    const accepted = { ...S_ELECTION, electionAcceptedOn: '2027-04-01' };
    expect(statusRowFlags(accepted, '2027-05-01').planned).toBe(false);
  });

  it('does not flag a plain past row', () => {
    expect(statusRowFlags(LLC, '2026-09-30').planned).toBe(false);
  });
});

describe('electionStatutoryDueDate', () => {
  it('computes 2 months and 15 days for Form 2553', () => {
    expect(electionStatutoryDueDate('2553', '2027-01-01')).toBe('2027-03-15');
    // IRS example: a tax year beginning January 7 is due March 21
    expect(electionStatutoryDueDate('2553', '2027-01-07')).toBe('2027-03-21');
    // Month-end clamping: Dec 31 + 2 months → Feb 28/29, then + 14 days
    expect(electionStatutoryDueDate('2553', '2026-12-31')).toBe('2027-03-14');
  });

  it('computes 75 days for Form 8832', () => {
    expect(electionStatutoryDueDate('8832', '2027-01-01')).toBe('2027-03-17');
  });

  it('has no deadline without an election form', () => {
    expect(electionStatutoryDueDate(null, '2027-01-01')).toBeNull();
  });
});

describe('small helpers', () => {
  it('validates ISO dates strictly', () => {
    expect(isIsoDate('2027-02-28')).toBe(true);
    expect(isIsoDate('2027-02-30')).toBe(false);
    expect(isIsoDate('2027-2-3')).toBe(false);
    expect(isIsoDate(20270101)).toBe(false);
  });

  it('detects mid-year effective dates', () => {
    expect(isMidYear('2027-01-01')).toBe(false);
    expect(isMidYear('2027-07-01')).toBe(true);
  });

  it('describes a status', () => {
    expect(describeStatus(S_ELECTION)).toBe('Single-member LLC taxed as an S-corp (Form 1120-S)');
    expect(describeStatus(LLC)).toBe('Single-member LLC, disregarded (Schedule C/F)');
    expect(describeStatus({ legalForm: 'household', taxClassification: 'individual' })).toBe(
      'Household',
    );
  });
});

describe('formatYearRanges', () => {
  it('compresses consecutive years', () => {
    expect(formatYearRanges([2028, 2016, 2017, 2018, 2026, 2027])).toBe('2016–2018, 2026–2028');
    expect(formatYearRanges([2027])).toBe('2027');
    expect(formatYearRanges([])).toBe('');
  });
});

describe('describeAffectedYears', () => {
  const window = { fromYear: 2016, toYear: 2028 };
  it('says "onward" when the change runs past the window', () => {
    expect(describeAffectedYears([2027, 2028], window)).toBe('Tax years 2027 onward change treatment.');
  });
  it('says "through" for a since-inception correction', () => {
    expect(describeAffectedYears([2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026], window)).toBe(
      'Every tax year through 2026 changes treatment.',
    );
  });
  it('lists bounded ranges and handles the extremes', () => {
    expect(describeAffectedYears([2027], window)).toBe('Tax years whose treatment changes: 2027.');
    expect(describeAffectedYears([], window)).toBe('No tax year changes treatment.');
    const all = Array.from({ length: 13 }, (_, i) => 2016 + i);
    expect(describeAffectedYears(all, window)).toBe('Every tax year changes treatment.');
  });
});
