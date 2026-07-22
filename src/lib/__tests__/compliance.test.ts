/**
 * Compliance calendar — pure deadline-generation tests.
 * Exercises complianceItemsForYear (no prisma / no I/O).
 */

import { describe, expect, it } from 'vitest';
import {
  adjustDueDate,
  complianceItemsForYear,
  complianceStatusKey,
  type ComplianceItem,
} from '../compliance';

function byKey(items: ComplianceItem[], key: string): ComplianceItem[] {
  return items.filter(i => i.key === key);
}

function one(items: ComplianceItem[], key: string): ComplianceItem {
  const matches = byKey(items, key);
  expect(matches, `expected exactly one '${key}' item`).toHaveLength(1);
  return matches[0];
}

describe('complianceItemsForYear — farm business activity', () => {
  it('adds farmer + NC farm items for a farm-labeled pass-through in NC', () => {
    const items = complianceItemsForYear('sole_prop', 'NC', 2026, 'farm');
    expect(one(items, 'fed-farmer-jan15').dueDate).toBe('2027-01-15');
    // Mar 1, 2026 is a Sunday — §7503 rolls the deadline to Monday.
    expect(one(items, 'fed-farmer-mar1').dueDate).toBe('2026-03-02');
    expect(one(items, 'fed-farmer-mar1').href).toBe('/business/reports/schedule-f');
    expect(one(items, 'nc-puv-listing').severity).toBe('admin');
    expect(one(items, 'nc-e595qf').description).toContain('$10,000');
  });

  it('llc_single farm keeps the NC annual report alongside the farm items', () => {
    const items = complianceItemsForYear('llc_single', 'NC', 2026, 'farm');
    expect(byKey(items, 'nc-annual-report')).toHaveLength(1);
    expect(byKey(items, 'fed-farmer-mar1')).toHaveLength(1);
  });

  it('adds no farm items for general activity or when omitted', () => {
    const general = complianceItemsForYear('sole_prop', 'NC', 2026, 'general');
    expect(byKey(general, 'fed-farmer-mar1')).toHaveLength(0);
    const omitted = complianceItemsForYear('sole_prop', 'NC', 2026);
    expect(byKey(omitted, 'nc-puv-listing')).toHaveLength(0);
  });

  it('keeps federal farmer items but drops NC farm items outside NC', () => {
    const items = complianceItemsForYear('sole_prop', 'VA', 2026, 'farm');
    expect(byKey(items, 'fed-farmer-mar1')).toHaveLength(1);
    expect(byKey(items, 'fed-farmer-jan15')).toHaveLength(1);
    expect(byKey(items, 'nc-puv-listing')).toHaveLength(0);
    expect(byKey(items, 'nc-e595qf')).toHaveLength(0);
  });

  it('does not add farm items to non-pass-through entities', () => {
    const items = complianceItemsForYear('s_corp', 'NC', 2026, 'farm');
    expect(byKey(items, 'fed-farmer-mar1')).toHaveLength(0);
  });
});

describe('complianceItemsForYear — household', () => {
  const items = complianceItemsForYear('household', 'NC', 2026);

  it('generates the four 1040-ES quarterlies with Q4 in January of year+1', () => {
    const quarterlies = byKey(items, 'fed-1040es');
    expect(quarterlies).toHaveLength(4);
    expect(quarterlies.map(q => [q.period, q.dueDate])).toEqual([
      ['2026-Q1', '2026-04-15'],
      ['2026-Q2', '2026-06-15'],
      ['2026-Q3', '2026-09-15'],
      ['2026-Q4', '2027-01-15'],
    ]);
    for (const q of quarterlies) {
      expect(q.severity).toBe('payment');
      expect(q.href).toBe('/taxes/estimated');
    }
  });

  it('includes the April 15 federal filing with the October extension note', () => {
    const filing = one(items, 'fed-1040');
    expect(filing.dueDate).toBe('2026-04-15');
    expect(filing.period).toBe('2026');
    expect(filing.severity).toBe('filing');
    expect(filing.description).toContain('October 15, 2026');
    // The filing due in 2026 covers the 2025 tax year.
    expect(filing.description).toContain('2025');
  });

  it('adds the NC D-400 only for NC filers', () => {
    expect(byKey(items, 'nc-d400')).toHaveLength(1);
    const caItems = complianceItemsForYear('household', 'CA', 2026);
    expect(byKey(caItems, 'nc-d400')).toHaveLength(0);
  });

  it('has no business-only items', () => {
    for (const key of ['fed-1099-nec', 'fed-941', 'fed-w2-w3', 'nc-annual-report', 'fed-990']) {
      expect(byKey(items, key)).toHaveLength(0);
    }
  });
});

describe('complianceItemsForYear — pass-through businesses', () => {
  it('sole_prop = household set + 1099-NEC, but NO NC annual report', () => {
    const items = complianceItemsForYear('sole_prop', 'NC', 2026);
    expect(byKey(items, 'fed-1040es')).toHaveLength(4);
    // Jan 31, 2026 is a Saturday — rolls to Monday Feb 2.
    expect(one(items, 'fed-1099-nec').dueDate).toBe('2026-02-02');
    expect(one(items, 'fed-1099-nec').href).toBe('/business/reports/1099');
    expect(byKey(items, 'nc-annual-report')).toHaveLength(0);
  });

  it('llc_single adds the NC annual report with the online fee note (NC only)', () => {
    const nc = complianceItemsForYear('llc_single', 'nc', 2026); // case-insensitive
    const report = one(nc, 'nc-annual-report');
    expect(report.dueDate).toBe('2026-04-15');
    expect(report.severity).toBe('admin');
    expect(report.description).toContain('$203');

    const other = complianceItemsForYear('llc_single', 'CA', 2026);
    expect(byKey(other, 'nc-annual-report')).toHaveLength(0);
  });

  it('llc_partnership: 1065 + K-1s on March 15, 1099-NEC, NC report — no 1040-ES', () => {
    const items = complianceItemsForYear('llc_partnership', 'NC', 2026);
    // Mar 15, 2026 is a Sunday — rolls to Monday Mar 16.
    expect(one(items, 'fed-1065').dueDate).toBe('2026-03-16');
    expect(one(items, 'fed-1065').description).toContain('September 15, 2026');
    expect(one(items, 'fed-k1').dueDate).toBe('2026-03-16');
    expect(one(items, 'fed-1099-nec').dueDate).toBe('2026-02-02');
    expect(one(items, 'nc-annual-report').dueDate).toBe('2026-04-15');
    expect(byKey(items, 'fed-1040es')).toHaveLength(0);
  });
});

describe('complianceItemsForYear — corporations', () => {
  it('s_corp: 1120-S, W-2/W-3, 941 quarterlies, NC report + franchise, 1099-NEC', () => {
    const items = complianceItemsForYear('s_corp', 'NC', 2026);
    expect(one(items, 'fed-1120s').dueDate).toBe('2026-03-16'); // Mar 15 is a Sunday
    expect(one(items, 'fed-w2-w3').dueDate).toBe('2026-02-02'); // Jan 31 is a Saturday

    const f941 = byKey(items, 'fed-941');
    expect(f941.map(q => [q.period, q.dueDate])).toEqual([
      ['2026-Q1', '2026-04-30'],
      ['2026-Q2', '2026-07-31'],
      ['2026-Q3', '2026-11-02'], // Oct 31 is a Saturday
      ['2026-Q4', '2027-02-01'], // Jan 31, 2027 is a Sunday
    ]);

    expect(one(items, 'nc-annual-report').dueDate).toBe('2026-04-15');
    const franchise = one(items, 'nc-franchise-tax');
    expect(franchise.dueDate).toBe('2026-04-15');
    expect(franchise.severity).toBe('payment');
    expect(franchise.description).toContain('CD-401S');
    expect(one(items, 'fed-1099-nec').dueDate).toBe('2026-02-02');
  });

  it('c_corp: 1120 on April 15 with October extension, 941s, W-2s, NC franchise', () => {
    const items = complianceItemsForYear('c_corp', 'NC', 2026);
    const filing = one(items, 'fed-1120');
    expect(filing.dueDate).toBe('2026-04-15');
    expect(filing.description).toContain('October 15, 2026');
    expect(byKey(items, 'fed-941')).toHaveLength(4);
    expect(one(items, 'fed-w2-w3').dueDate).toBe('2026-02-02');
    expect(one(items, 'nc-franchise-tax').description).toContain('CD-405');

    // No NC items for a non-NC corporation.
    const other = complianceItemsForYear('c_corp', null, 2026);
    expect(byKey(other, 'nc-annual-report')).toHaveLength(0);
    expect(byKey(other, 'nc-franchise-tax')).toHaveLength(0);
  });
});

describe('complianceItemsForYear — nonprofit', () => {
  it('990-N due May 15 with the 990 helper link, plus conditional 1099-NEC', () => {
    const items = complianceItemsForYear('nonprofit_501c3', 'NC', 2026);
    const form990 = one(items, 'fed-990');
    expect(form990.dueDate).toBe('2026-05-15');
    expect(form990.href).toBe('/business/reports/990');
    expect(form990.description).toContain('15th day of the 5th month');
    expect(one(items, 'fed-1099-nec').description).toMatch(/^If the organization paid contractors/);
    // Nonprofits get no 1040-ES or corporate filings.
    expect(byKey(items, 'fed-1040es')).toHaveLength(0);
    expect(byKey(items, 'fed-1120')).toHaveLength(0);
  });
});

describe('complianceItemsForYear — invariants', () => {
  const ENTITY_TYPES = [
    'household', 'sole_prop', 'llc_single', 'llc_partnership',
    's_corp', 'c_corp', 'nonprofit_501c3',
  ] as const;

  it('key+period is unique within every rule set', () => {
    for (const type of ENTITY_TYPES) {
      const items = complianceItemsForYear(type, 'NC', 2026);
      const keys = items.map(i => complianceStatusKey(i.key, i.period));
      expect(new Set(keys).size, `duplicates in ${type}`).toBe(keys.length);
    }
  });

  it('every item has a well-formed ISO due date and matching period year', () => {
    for (const type of ENTITY_TYPES) {
      for (const item of complianceItemsForYear(type, 'NC', 2026)) {
        expect(item.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(item.period).toMatch(/^2026(-Q[1-4])?$/);
        // Due dates are in the item year, except Q4 schedules due in January
        // (or early February when Jan 31 rolls past a weekend/holiday).
        const dueYear = item.dueDate.slice(0, 4);
        if (dueYear === '2027') {
          expect(item.period).toBe('2026-Q4');
          expect(['01', '02']).toContain(item.dueDate.slice(5, 7));
        } else {
          expect(dueYear).toBe('2026');
        }
      }
    }
  });

  it('adjustDueDate handles observed holidays and chained rolls', () => {
    // Weekday, no holiday → untouched.
    expect(adjustDueDate('2026-04-15')).toEqual({ dueDate: '2026-04-15', note: null });
    // Plain Saturday → Monday.
    expect(adjustDueDate('2026-01-31').dueDate).toBe('2026-02-02');
    // Jul 4, 2026 is a Saturday, so Independence Day is OBSERVED Friday
    // Jul 3 — a deadline on Fri Jul 3 rolls over the observed holiday and
    // the weekend to Monday Jul 6.
    expect(adjustDueDate('2026-07-03').dueDate).toBe('2026-07-06');
    // MLK Day (3rd Monday of January) blocks a Saturday roll-forward:
    // Jan 17, 2026 (Sat) → Sun → MLK Mon Jan 19 → Tue Jan 20.
    expect(adjustDueDate('2026-01-17').dueDate).toBe('2026-01-20');
  });

  it('rolls weekend/holiday due dates to the next business day (IRC §7503)', () => {
    // Apr 15, 2028 is a Saturday; Apr 17 is DC Emancipation Day observed
    // (Apr 16 falls on Sunday) — the deadline lands on Tuesday Apr 18,
    // exactly as the IRS schedules it.
    const items = complianceItemsForYear('household', null, 2028);
    const filing = one(items, 'fed-1040');
    expect(filing.dueDate).toBe('2028-04-18');
    expect(filing.description).toContain('weekend or legal holiday');
    // A plain weekday due date is untouched (Apr 15, 2026 is a Wednesday).
    const weekday = one(complianceItemsForYear('household', null, 2026), 'fed-1040');
    expect(weekday.dueDate).toBe('2026-04-15');
    expect(weekday.description).not.toContain('weekend');
  });
});
