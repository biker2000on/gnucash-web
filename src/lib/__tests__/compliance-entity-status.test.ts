/**
 * Compliance calendar resolved against the effective-dated entity status
 * history (complianceItemsForHistory / entityStatusItems). Pure, no I/O.
 */

import { describe, expect, it } from 'vitest';
import {
  complianceItemsForHistory,
  complianceItemsForYear,
  entityStatusItems,
  ITEMS_COVERING_PRIOR_TAX_YEAR,
  itemTaxYear,
  type ComplianceItem,
} from '../compliance';
import {
  fromLegacyEntityType,
  INCEPTION_DATE,
  type EntityStatusRow,
} from '../entity-status';
import type { EntityType } from '../services/entity.service';

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

const keys = (items: ComplianceItem[]) => items.map((i) => `${i.key}|${i.period}`).sort();

const LLC = row({ id: 1, effectiveFrom: INCEPTION_DATE });
const S_ELECTION = row({
  id: 2,
  effectiveFrom: '2027-01-01',
  taxClassification: 's_corp',
  electionForm: '2553',
});

describe('complianceItemsForHistory', () => {
  const ALL: EntityType[] = [
    'household',
    'sole_prop',
    'llc_single',
    'llc_partnership',
    's_corp',
    'c_corp',
    'nonprofit_501c3',
  ];

  it('matches complianceItemsForYear exactly when the status never changes', () => {
    for (const type of ALL) {
      const history = [row({ effectiveFrom: INCEPTION_DATE, ...fromLegacyEntityType(type) })];
      for (const state of [null, 'NC']) {
        for (const activity of ['general', 'farm'] as const) {
          expect(keys(complianceItemsForHistory(history, state, 2026, activity))).toEqual(
            keys(complianceItemsForYear(type, state, 2026, activity)),
          );
        }
      }
    }
  });

  it('keeps the year before an election on the old rule set', () => {
    const items = complianceItemsForHistory([LLC, S_ELECTION], 'NC', 2026);
    expect(keys(items)).toEqual(keys(complianceItemsForYear('llc_single', 'NC', 2026)));
  });

  it('splits the election year: returns for the prior year, S-corp items for the new one', () => {
    const items = complianceItemsForHistory([LLC, S_ELECTION], 'NC', 2027);
    const k = new Set(items.map((i) => i.key));
    // Filed in 2027 but covering 2026, when it was still disregarded.
    expect(k.has('fed-1040')).toBe(true);
    expect(k.has('nc-d400')).toBe(true);
    expect(k.has('fed-1120s')).toBe(false);
    expect(k.has('fed-w2-w3')).toBe(false);
    // Covering 2027, now an S-corp.
    expect(items.filter((i) => i.key === 'fed-941').map((i) => i.period)).toEqual([
      '2027-Q1',
      '2027-Q2',
      '2027-Q3',
      '2027-Q4',
    ]);
    expect(k.has('fed-1040es')).toBe(false);
    // History-derived items.
    expect(items.find((i) => i.key === 'fed-election-2553')).toMatchObject({
      dueDate: '2027-03-15',
      period: '2027-01-01',
      severity: 'filing',
    });
    // Jan 1 is a holiday; the business-day roll moves it to Monday Jan 4.
    expect(items.find((i) => i.key === 'entity-scorp-payroll-setup')?.dueDate).toBe('2027-01-04');
  });

  it('files the S-corp return the year after the election takes effect', () => {
    const k = new Set(complianceItemsForHistory([LLC, S_ELECTION], 'NC', 2028).map((i) => i.key));
    expect(k.has('fed-1120s')).toBe(true);
    expect(k.has('fed-w2-w3')).toBe(true);
    expect(k.has('fed-1040')).toBe(false);
  });

  it('charges the LLC annual-report fee to an LLC taxed as an S-corp', () => {
    const report = complianceItemsForHistory([LLC, S_ELECTION], 'NC', 2027).find(
      (i) => i.key === 'nc-annual-report',
    );
    expect(report?.description).toContain('$200');
    const corp = row({ effectiveFrom: INCEPTION_DATE, legalForm: 'corporation', taxClassification: 's_corp' });
    const corpReport = complianceItemsForHistory([corp], 'NC', 2027).find(
      (i) => i.key === 'nc-annual-report',
    );
    expect(corpReport?.description).toContain('$25');
  });
});

describe('entityStatusItems', () => {
  it('drops the filing deadline once the election is filed and follows up on acceptance', () => {
    const filed = { ...S_ELECTION, electionFiledOn: '2026-12-10' };
    const items = entityStatusItems([LLC, filed]);
    expect(items.some((i) => i.key === 'fed-election-2553')).toBe(false);
    expect(items.find((i) => i.key === 'fed-election-acceptance')).toMatchObject({
      dueDate: '2027-02-08',
      period: '2027-01-01',
    });
    const accepted = entityStatusItems([LLC, { ...filed, electionAcceptedOn: '2027-01-20' }]);
    expect(accepted.some((i) => i.key === 'fed-election-acceptance')).toBe(false);
  });

  it('models the Form 8832 75-day window', () => {
    const cCorp = row({
      id: 3,
      effectiveFrom: '2027-01-01',
      taxClassification: 'c_corp',
      electionForm: '8832',
    });
    expect(entityStatusItems([LLC, cCorp]).find((i) => i.key === 'fed-election-8832')?.dueDate).toBe(
      '2027-03-17',
    );
  });

  it('warns about short tax years for a mid-year change only', () => {
    const mid = row({ id: 4, effectiveFrom: '2027-07-01', taxClassification: 'c_corp' });
    const items = entityStatusItems([LLC, mid]);
    expect(items.find((i) => i.key === 'entity-short-tax-year')).toMatchObject({
      period: '2027-07-01',
      dueDate: '2027-07-01',
    });
    expect(entityStatusItems([LLC, S_ELECTION]).some((i) => i.key === 'entity-short-tax-year')).toBe(false);
    // A mid-year row that does not change the treatment is not a short year.
    const same = row({ id: 5, effectiveFrom: '2027-07-01' });
    expect(entityStatusItems([LLC, same])).toEqual([]);
  });

  it('does not ask for payroll setup on the since-inception row', () => {
    const sInception = row({ effectiveFrom: INCEPTION_DATE, taxClassification: 's_corp' });
    expect(entityStatusItems([sInception])).toEqual([]);
  });

  it('rolls election deadlines forward past weekends (§7503)', () => {
    // 2553 for a 2026-01-01 start: statutory 2026-03-15 is a Sunday.
    const early = row({ id: 6, effectiveFrom: '2026-01-01', taxClassification: 's_corp', electionForm: '2553' });
    expect(entityStatusItems([LLC, early]).find((i) => i.key === 'fed-election-2553')?.dueDate).toBe(
      '2026-03-16',
    );
  });
});

describe('itemTaxYear', () => {
  it('maps annual returns to the prior tax year', () => {
    expect(itemTaxYear({ key: 'fed-1120s', period: '2027' })).toBe(2026);
    expect(itemTaxYear({ key: 'fed-941', period: '2027-Q1' })).toBe(2027);
    expect(itemTaxYear({ key: 'nc-annual-report', period: '2027' })).toBe(2027);
  });

  it('lists only keys the generator actually emits', () => {
    const emitted = new Set<string>();
    for (const type of ['household', 'sole_prop', 'llc_single', 'llc_partnership', 's_corp', 'c_corp', 'nonprofit_501c3'] as EntityType[]) {
      for (const item of complianceItemsForYear(type, 'NC', 2026, 'farm')) emitted.add(item.key);
    }
    for (const key of ITEMS_COVERING_PRIOR_TAX_YEAR) expect(emitted.has(key), key).toBe(true);
  });
});
