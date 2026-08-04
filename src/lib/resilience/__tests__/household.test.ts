/**
 * Household identity resolution for the planning packs.
 *
 * These helpers are pure — the service loads the roster from the database and
 * passes it in — so they can be exercised without any mocking.
 */
import { describe, it, expect } from 'vitest';
import {
  COLLEGE_START_AGE,
  LEGACY_PACK_FILING_STATUS,
  SEED_BIRTH_YEAR,
  SEED_PLANNED_CLAIM_AGE,
  birthYearFromBirthday,
  findDependentMember,
  mapEntityFilingStatus,
  normalizePersonName,
  resolveEducationProfile,
  resolveFilingStatus,
  resolveLifeProfile,
  resolveRetirementIncomeProfile,
  withResolvedFilingStatus,
} from '../household';
import { analyzeRetirementIncome } from '../retirement-income-core';
import { calculateLifeNeeds } from '../core';
import { calculateEducationPlan } from '../p3-core';
import type {
  EducationChild,
  EducationProfile,
  HouseholdMember,
  LifePerson,
  LifeProfile,
  RetirementIncomeProfile,
  RetirementPerson,
} from '../types';

const ROSTER: HouseholdMember[] = [
  { role: 'self', name: 'Justin Crawford', birthday: '1978-04-02' },
  { role: 'spouse', name: 'Cara Crawford', birthday: '1980-09-14' },
  { role: 'dependent', name: 'Rowan Crawford', birthday: '2012-01-20' },
];

function retirementPerson(overrides: Partial<RetirementPerson> = {}): RetirementPerson {
  return {
    id: 'p1',
    name: 'Stored Name',
    birthYear: 1965,
    pia: 2_400,
    annualEarnings: null,
    plannedClaimAge: 67,
    ...overrides,
  };
}

function retirementProfile(people: RetirementPerson[]): RetirementIncomeProfile {
  return {
    people,
    balances: { taxable: 200_000, traditional: 500_000, roth: 100_000, hsa: 20_000 },
    settings: {
      filingStatus: null,
      annualSpending: 80_000,
      horizonAge: 90,
      colaPct: 2.5,
      realReturnPct: 4,
      sequencingPreference: 'taxable_first',
    },
  };
}

function lifePerson(overrides: Partial<LifePerson> = {}): LifePerson {
  return {
    id: 'l1',
    name: 'Stored Name',
    annualIncome: 90_000,
    replacementYears: 10,
    debts: 250_000,
    educationGoals: 100_000,
    finalExpenses: 20_000,
    liquidAssets: 50_000,
    existingCoverage: 250_000,
    survivorAnnualIncome: 40_000,
    survivorAnnualExpenses: 70_000,
    ...overrides,
  };
}

describe('mapEntityFilingStatus', () => {
  it('maps the joint 1040 statuses to married_joint', () => {
    expect(mapEntityFilingStatus('mfj')).toBe('married_joint');
    expect(mapEntityFilingStatus('qss')).toBe('married_joint');
  });

  it('maps the non-joint 1040 statuses to single', () => {
    expect(mapEntityFilingStatus('single')).toBe('single');
    expect(mapEntityFilingStatus('mfs')).toBe('single');
    expect(mapEntityFilingStatus('hoh')).toBe('single');
  });

  it('tolerates casing and surrounding whitespace', () => {
    expect(mapEntityFilingStatus(' MFJ ')).toBe('married_joint');
  });

  it('returns null for unset or unrecognised values so the pack keeps its default', () => {
    expect(mapEntityFilingStatus(null)).toBeNull();
    expect(mapEntityFilingStatus(undefined)).toBeNull();
    expect(mapEntityFilingStatus('')).toBeNull();
    expect(mapEntityFilingStatus('married')).toBeNull();
  });
});

describe('resolveFilingStatus', () => {
  it('prefers an explicit pack override over household settings', () => {
    expect(resolveFilingStatus('single', 'married_joint')).toBe('single');
  });

  it('falls back to household settings when the pack has no override', () => {
    expect(resolveFilingStatus(null, 'single')).toBe('single');
  });

  it('falls back to the legacy pack default when neither is set', () => {
    expect(resolveFilingStatus(null, null)).toBe(LEGACY_PACK_FILING_STATUS);
    expect(LEGACY_PACK_FILING_STATUS).toBe('married_joint');
  });
});

describe('birthYearFromBirthday', () => {
  it('reads the year from an ISO birthday', () => {
    expect(birthYearFromBirthday('1978-04-02')).toBe(1978);
  });

  it('returns null for missing or out-of-range values', () => {
    expect(birthYearFromBirthday(null)).toBeNull();
    expect(birthYearFromBirthday('')).toBeNull();
    expect(birthYearFromBirthday('not-a-date')).toBeNull();
    expect(birthYearFromBirthday('1000-01-01')).toBeNull();
  });
});

describe('resolveRetirementIncomeProfile', () => {
  it('takes name and birth year from the linked household member', () => {
    const resolved = resolveRetirementIncomeProfile(
      retirementProfile([retirementPerson({ memberRole: 'self' })]),
      ROSTER,
    );
    expect(resolved.people[0]).toMatchObject({
      name: 'Justin Crawford',
      birthYear: 1978,
      // Pack-specific inputs are never touched.
      pia: 2_400,
      plannedClaimAge: 67,
    });
  });

  it('falls back to the stored values when the linked member is not on the roster', () => {
    const resolved = resolveRetirementIncomeProfile(
      retirementProfile([retirementPerson({ memberRole: 'spouse' })]),
      [ROSTER[0]],
    );
    expect(resolved.people[0]).toMatchObject({ name: 'Stored Name', birthYear: 1965 });
  });

  it('keeps the stored birth year when the linked member has no birthday recorded', () => {
    const resolved = resolveRetirementIncomeProfile(
      retirementProfile([retirementPerson({ memberRole: 'self' })]),
      [{ role: 'self', name: 'Justin Crawford', birthday: null }],
    );
    expect(resolved.people[0]).toMatchObject({ name: 'Justin Crawford', birthYear: 1965 });
  });

  it('keeps the stored name when the linked member has no name recorded', () => {
    const resolved = resolveRetirementIncomeProfile(
      retirementProfile([retirementPerson({ memberRole: 'self' })]),
      [{ role: 'self', name: '', birthday: '1978-04-02' }],
    );
    expect(resolved.people[0]).toMatchObject({ name: 'Stored Name', birthYear: 1978 });
  });

  it('leaves a legacy person (no memberRole) untouched even with a full roster', () => {
    const resolved = resolveRetirementIncomeProfile(
      retirementProfile([retirementPerson()]),
      ROSTER,
    );
    expect(resolved.people[0]).toMatchObject({ name: 'Stored Name', birthYear: 1965 });
  });

  it('seeds self then spouse from the roster when the pack has no people', () => {
    const resolved = resolveRetirementIncomeProfile(retirementProfile([]), ROSTER);
    expect(resolved.people).toHaveLength(2);
    expect(resolved.people[0]).toMatchObject({
      memberRole: 'self',
      name: 'Justin Crawford',
      birthYear: 1978,
      pia: 0,
      plannedClaimAge: SEED_PLANNED_CLAIM_AGE,
    });
    expect(resolved.people[1]).toMatchObject({ memberRole: 'spouse', name: 'Cara Crawford', birthYear: 1980 });
    // Dependents are household members but not retirement filers.
    expect(resolved.people.some(person => person.memberRole === 'dependent')).toBe(false);
  });

  it('uses stable ids when seeding so repeated reads do not churn', () => {
    const first = resolveRetirementIncomeProfile(retirementProfile([]), ROSTER);
    const second = resolveRetirementIncomeProfile(retirementProfile([]), ROSTER);
    expect(first.people.map(p => p.id)).toEqual(second.people.map(p => p.id));
  });

  it('falls back to a default birth year when a seeded member has no birthday', () => {
    const resolved = resolveRetirementIncomeProfile(
      retirementProfile([]),
      [{ role: 'self', name: 'Justin Crawford', birthday: null }],
    );
    expect(resolved.people[0]).toMatchObject({ name: 'Justin Crawford', birthYear: SEED_BIRTH_YEAR });
  });

  it('leaves an empty pack empty when there is no household roster', () => {
    expect(resolveRetirementIncomeProfile(retirementProfile([]), []).people).toEqual([]);
  });
});

describe('resolveLifeProfile', () => {
  it('takes the name from the linked household member and keeps every financial input', () => {
    const resolved = resolveLifeProfile(
      { people: [lifePerson({ memberRole: 'spouse' })] },
      ROSTER,
    );
    expect(resolved.people[0]).toMatchObject({
      name: 'Cara Crawford',
      annualIncome: 90_000,
      debts: 250_000,
      existingCoverage: 250_000,
      survivorAnnualExpenses: 70_000,
    });
  });

  it('falls back to the stored name when the member is not on the roster', () => {
    const resolved = resolveLifeProfile({ people: [lifePerson({ memberRole: 'spouse' })] }, [ROSTER[0]]);
    expect(resolved.people[0].name).toBe('Stored Name');
  });

  it('seeds self and spouse when the pack is empty', () => {
    const resolved = resolveLifeProfile({ people: [] }, ROSTER);
    expect(resolved.people.map(person => person.name)).toEqual(['Justin Crawford', 'Cara Crawford']);
    expect(resolved.people[0]).toMatchObject({ memberRole: 'self', annualIncome: 0, existingCoverage: 0 });
  });

  it('leaves an empty pack empty when there is no household roster', () => {
    expect(resolveLifeProfile({ people: [] }, []).people).toEqual([]);
  });

  it('does not change the DIME / survivor math for a linked person', () => {
    const stored: LifeProfile = { people: [lifePerson({ memberRole: 'spouse' })] };
    const resolved = resolveLifeProfile(stored, ROSTER);
    expect(calculateLifeNeeds(resolved.people[0])).toMatchObject(
      { ...calculateLifeNeeds(stored.people[0]), person: resolved.people[0] },
    );
  });
});

function educationChild(overrides: Partial<EducationChild> = {}): EducationChild {
  return {
    id: 'c1',
    name: 'Stored Student',
    birthYear: 2010,
    collegeStartYear: 2028,
    schoolType: 'public_in_state',
    yearsOfSchool: 4,
    annualCostToday: 30_000,
    tuitionInflationRate: 5,
    current529Balance: 10_000,
    expectedAnnualReturn: 6,
    plannedMonthlyContribution: 250,
    stateDeductionLimit: 2_500,
    contributions: [],
    ...overrides,
  };
}

/** Two dependents who share a first name, to exercise the ambiguity guard. */
const TWO_DEPENDENTS: HouseholdMember[] = [
  { role: 'self', name: 'Justin Crawford', birthday: '1978-04-02' },
  { role: 'dependent', name: 'Rowan Crawford', birthday: '2012-01-20' },
  { role: 'dependent', name: 'Sage Crawford', birthday: '2015-06-11' },
];

describe('normalizePersonName', () => {
  it('lowercases, strips punctuation and collapses whitespace', () => {
    expect(normalizePersonName("  Rowan   O'Brien-Crawford. ")).toBe('rowan obrien-crawford');
    expect(normalizePersonName('Rowan Crawford')).toBe(normalizePersonName('rowan  crawford,'));
  });
});

describe('findDependentMember', () => {
  it('links a student to the one dependent whose name matches', () => {
    const found = findDependentMember(
      { memberRole: 'dependent', memberName: 'Rowan Crawford', name: 'Rowan' },
      TWO_DEPENDENTS,
    );
    expect(found).toMatchObject({ name: 'Rowan Crawford', birthday: '2012-01-20' });
  });

  it('matches case- and punctuation-insensitively', () => {
    expect(findDependentMember(
      { memberRole: 'dependent', memberName: 'rowan  crawford.', name: '' },
      TWO_DEPENDENTS,
    )).toMatchObject({ name: 'Rowan Crawford' });
  });

  it('falls back to the stored name when memberName is absent', () => {
    expect(findDependentMember(
      { memberRole: 'dependent', memberName: null, name: 'Sage Crawford' },
      TWO_DEPENDENTS,
    )).toMatchObject({ name: 'Sage Crawford' });
  });

  it('returns null when no dependent matches', () => {
    expect(findDependentMember(
      { memberRole: 'dependent', memberName: 'Quinn Crawford', name: 'Quinn' },
      TWO_DEPENDENTS,
    )).toBeNull();
  });

  it('refuses to guess when several dependents share the name', () => {
    const twins: HouseholdMember[] = [
      { role: 'dependent', name: 'Rowan Crawford', birthday: '2012-01-20' },
      { role: 'dependent', name: 'rowan crawford', birthday: '2014-03-05' },
    ];
    expect(findDependentMember(
      { memberRole: 'dependent', memberName: 'Rowan Crawford', name: '' },
      twins,
    )).toBeNull();
  });

  it('never matches self or spouse, even by name', () => {
    expect(findDependentMember(
      { memberRole: 'dependent', memberName: 'Justin Crawford', name: '' },
      TWO_DEPENDENTS,
    )).toBeNull();
  });

  it('returns null for an unlinked student', () => {
    expect(findDependentMember({ memberRole: null, memberName: null, name: 'Rowan Crawford' }, TWO_DEPENDENTS))
      .toBeNull();
  });
});

describe('resolveEducationProfile', () => {
  it('takes name and birth year from the linked dependent', () => {
    const resolved = resolveEducationProfile(
      { children: [educationChild({ memberRole: 'dependent', memberName: 'Rowan Crawford' })] },
      TWO_DEPENDENTS,
    );
    expect(resolved.children[0]).toMatchObject({
      name: 'Rowan Crawford',
      birthYear: 2012,
      // Every 529 input is left alone.
      current529Balance: 10_000,
      plannedMonthlyContribution: 250,
      collegeStartYear: 2028,
      stateDeductionLimit: 2_500,
    });
  });

  it('keeps stored values when the link is ambiguous', () => {
    const twins: HouseholdMember[] = [
      { role: 'dependent', name: 'Rowan Crawford', birthday: '2012-01-20' },
      { role: 'dependent', name: 'Rowan Crawford', birthday: '2014-03-05' },
    ];
    const resolved = resolveEducationProfile(
      { children: [educationChild({ memberRole: 'dependent', memberName: 'Rowan Crawford' })] },
      twins,
    );
    expect(resolved.children[0]).toMatchObject({ name: 'Stored Student', birthYear: 2010 });
  });

  it('keeps stored values when the dependent left the roster', () => {
    const resolved = resolveEducationProfile(
      { children: [educationChild({ memberRole: 'dependent', memberName: 'Rowan Crawford' })] },
      [TWO_DEPENDENTS[0]],
    );
    expect(resolved.children[0]).toMatchObject({ name: 'Stored Student', birthYear: 2010 });
  });

  it('keeps the stored birth year when the dependent has no birthday', () => {
    const resolved = resolveEducationProfile(
      { children: [educationChild({ memberRole: 'dependent', memberName: 'Rowan Crawford' })] },
      [{ role: 'dependent', name: 'Rowan Crawford', birthday: null }],
    );
    expect(resolved.children[0]).toMatchObject({ name: 'Rowan Crawford', birthYear: 2010 });
  });

  it('leaves a legacy student (no memberRole) untouched even with a matching roster', () => {
    const resolved = resolveEducationProfile(
      { children: [educationChild({ name: 'Rowan Crawford' })] },
      TWO_DEPENDENTS,
    );
    expect(resolved.children[0]).toMatchObject({ name: 'Rowan Crawford', birthYear: 2010 });
  });

  it('seeds one student per named dependent, deriving college start from the birthday', () => {
    const resolved = resolveEducationProfile({ children: [] }, TWO_DEPENDENTS, new Date('2026-08-03T00:00:00Z'));
    expect(resolved.children).toHaveLength(2);
    expect(resolved.children[0]).toMatchObject({
      memberRole: 'dependent',
      memberName: 'Rowan Crawford',
      name: 'Rowan Crawford',
      birthYear: 2012,
      collegeStartYear: 2012 + COLLEGE_START_AGE,
    });
    expect(resolved.children[1]).toMatchObject({ name: 'Sage Crawford', birthYear: 2015, collegeStartYear: 2033 });
    // Adults are never students.
    expect(resolved.children.some(child => child.name === 'Justin Crawford')).toBe(false);
  });

  it('uses the pack defaults when a seeded dependent has no birthday', () => {
    const resolved = resolveEducationProfile(
      { children: [] },
      [{ role: 'dependent', name: 'Rowan Crawford', birthday: null }],
      new Date('2026-08-03T00:00:00Z'),
    );
    expect(resolved.children[0]).toMatchObject({ birthYear: 2021, collegeStartYear: 2039 });
  });

  it('skips nameless dependents, which could never be linked back', () => {
    const resolved = resolveEducationProfile(
      { children: [] },
      [{ role: 'dependent', name: '', birthday: '2012-01-20' }],
      new Date('2026-08-03T00:00:00Z'),
    );
    expect(resolved.children).toEqual([]);
  });

  it('uses stable ids when seeding so repeated reads do not churn', () => {
    const asOf = new Date('2026-08-03T00:00:00Z');
    const first = resolveEducationProfile({ children: [] }, TWO_DEPENDENTS, asOf);
    const second = resolveEducationProfile({ children: [] }, TWO_DEPENDENTS, asOf);
    expect(first.children.map(child => child.id)).toEqual(second.children.map(child => child.id));
    expect(first.children[0].id).toBe('household-dependent-rowan-crawford');
  });

  it('leaves an empty pack empty when there is no household roster', () => {
    expect(resolveEducationProfile({ children: [] }, []).children).toEqual([]);
  });

  it('does not change the 529 projection math for a linked student', () => {
    const asOf = new Date('2026-08-03T00:00:00Z');
    const stored: EducationProfile = {
      children: [educationChild({ memberRole: 'dependent', memberName: 'Rowan Crawford' })],
    };
    const resolved = resolveEducationProfile(stored, TWO_DEPENDENTS, asOf);
    const before = calculateEducationPlan(stored.children[0], asOf);
    const after = calculateEducationPlan(resolved.children[0], asOf);
    expect(after.projectedCost).toBe(before.projectedCost);
    expect(after.fundingGap).toBe(before.fundingGap);
    expect(after.requiredMonthlyContribution).toBe(before.requiredMonthlyContribution);
  });
});

describe('withResolvedFilingStatus', () => {
  it('applies the household value when the pack has no override', () => {
    const profile = withResolvedFilingStatus(retirementProfile([]), 'single');
    expect(profile.settings.filingStatus).toBe('single');
  });

  it('keeps an explicit pack override', () => {
    const base = retirementProfile([]);
    const profile = withResolvedFilingStatus(
      { ...base, settings: { ...base.settings, filingStatus: 'married_joint' } },
      'single',
    );
    expect(profile.settings.filingStatus).toBe('married_joint');
  });

  it('does not mutate the stored profile', () => {
    const base = retirementProfile([]);
    withResolvedFilingStatus(base, 'single');
    expect(base.settings.filingStatus).toBeNull();
  });
});

describe('backward compatibility with profiles saved before household integration', () => {
  const asOf = new Date('2026-08-03T00:00:00Z');
  /** Exactly what a pre-integration profile looks like: no memberRole anywhere. */
  const legacy: RetirementIncomeProfile = {
    people: [
      { id: 'p1', name: 'Justin', birthYear: 1978, pia: 2_400, annualEarnings: null, plannedClaimAge: 67 },
      { id: 'p2', name: 'Cara', birthYear: 1980, pia: 1_600, annualEarnings: null, plannedClaimAge: 65 },
    ],
    balances: { taxable: 200_000, traditional: 500_000, roth: 100_000, hsa: 20_000 },
    settings: {
      filingStatus: 'married_joint',
      annualSpending: 80_000,
      horizonAge: 90,
      colaPct: 2.5,
      realReturnPct: 4,
      sequencingPreference: 'taxable_first',
    },
  };

  it('produces identical results with no roster and no household filing status', () => {
    const before = analyzeRetirementIncome(legacy, asOf);
    const after = analyzeRetirementIncome(
      withResolvedFilingStatus(resolveRetirementIncomeProfile(legacy, []), null),
      asOf,
    );
    expect(after).toEqual(before);
  });

  it('is unaffected by a household roster, because nothing is linked to it', () => {
    const before = analyzeRetirementIncome(legacy, asOf);
    const after = analyzeRetirementIncome(
      withResolvedFilingStatus(resolveRetirementIncomeProfile(legacy, ROSTER), 'single'),
      asOf,
    );
    expect(after).toEqual(before);
  });

  /** A 529 profile exactly as it was saved before household integration. */
  const legacyEducation: EducationProfile = {
    children: [
      educationChild({ id: 'c1', name: 'Rowan Crawford', birthYear: 2012, collegeStartYear: 2030 }),
      educationChild({ id: 'c2', name: 'Sage Crawford', birthYear: 2015, collegeStartYear: 2033 }),
    ],
  };

  it('computes education plans identically with no roster', () => {
    const resolved = resolveEducationProfile(legacyEducation, [], asOf);
    expect(resolved.children).toEqual(legacyEducation.children);
    expect(resolved.children.map(child => calculateEducationPlan(child, asOf)))
      .toEqual(legacyEducation.children.map(child => calculateEducationPlan(child, asOf)));
  });

  it('computes education plans identically even when a matching roster exists', () => {
    // Names match the roster exactly, but with no memberRole nothing is linked.
    const resolved = resolveEducationProfile(legacyEducation, TWO_DEPENDENTS, asOf);
    expect(resolved.children).toEqual(legacyEducation.children);
    expect(resolved.children.map(child => calculateEducationPlan(child, asOf)))
      .toEqual(legacyEducation.children.map(child => calculateEducationPlan(child, asOf)));
  });

  it('treats an unresolved null filing status as the pack default the engine always used', () => {
    const withNull: RetirementIncomeProfile = {
      ...legacy,
      settings: { ...legacy.settings, filingStatus: null },
    };
    // `settings` is echoed back verbatim, so compare everything it drives.
    const stripSettings = (result: ReturnType<typeof analyzeRetirementIncome>) => {
      const copy: Partial<ReturnType<typeof analyzeRetirementIncome>> = { ...result };
      delete copy.settings;
      return copy;
    };
    expect(stripSettings(analyzeRetirementIncome(withNull, asOf)))
      .toEqual(stripSettings(analyzeRetirementIncome(legacy, asOf)));
  });
});
