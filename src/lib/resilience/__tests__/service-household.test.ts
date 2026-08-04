/**
 * Household integration through the resilience service, with a mocked database.
 *
 * Covers what the pure `household.test.ts` cannot: that the service actually
 * loads the roster and the household filing status, hands resolved data to the
 * engines, keeps the stored profile's `filingStatus: null` so the pack still
 * inherits, and that the section response shape stays additive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  stored: {} as Record<string, unknown>,
  /** Rows returned for gnucash_web_entity_members. */
  members: [] as Array<{ role: string; name: string; birthday: string | null }>,
  /** filing_status column on gnucash_web_entity_profiles; null = no row. */
  filingStatus: null as string | null,
  /** When true, entity queries throw — a fresh install with no entity tables. */
  entityTablesMissing: false,
}));

vi.mock('@/lib/db', () => ({
  query: vi.fn(async (text: string, params?: unknown[]) => {
    if (text.includes('CREATE TABLE') || text.includes('CREATE INDEX')) return { rows: [] };
    if (text.includes('gnucash_web_entity_members')) {
      if (state.entityTablesMissing) throw new Error('relation does not exist');
      return { rows: state.members };
    }
    if (text.includes('gnucash_web_entity_profiles')) {
      if (state.entityTablesMissing) throw new Error('relation does not exist');
      return { rows: state.filingStatus === null ? [] : [{ filing_status: state.filingStatus }] };
    }
    if (text.includes('INSERT INTO gnucash_web_resilience_profiles')) {
      state.stored[params![1] as string] = JSON.parse(params![2] as string);
      return { rows: [] };
    }
    if (text.includes('SELECT secret_encrypted')) return { rows: [] };
    if (text.includes('SELECT data')) {
      const section = params![1] as string;
      const data = state.stored[section];
      return {
        rows: data === undefined
          ? []
          : [{ data, secret_encrypted: null, updated_at: new Date() }],
      };
    }
    return { rows: [] };
  }),
}));
vi.mock('@/lib/secure-config', () => ({
  encryptSecret: vi.fn((value: string) => value),
  decryptSecret: vi.fn(() => null),
}));
vi.mock('@/lib/services/audit.service', () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/services/home.service', () => ({ listItems: vi.fn(async () => []) }));
vi.mock('@/lib/webhooks', () => ({ validateWebhookUrl: vi.fn(() => ({ ok: true })) }));
vi.mock('@/lib/provenance', () => ({ createCalculationTrace: vi.fn() }));
vi.mock('@/lib/book-scope', () => ({ getAccountGuidsForBook: vi.fn(async () => []) }));
vi.mock('@/lib/documents', () => ({ listLinkedDocuments: vi.fn(async () => []) }));

import {
  getResilienceSection,
  loadHouseholdFilingStatus,
  loadHouseholdRoster,
  saveResilienceProfile,
} from '../service';
import type {
  EducationProfile,
  HouseholdMember,
  LifeProfile,
  PlanningFilingStatus,
  RetirementIncomeProfile,
} from '../types';

const BOOK = 'c'.repeat(32);

interface HouseholdContext {
  members: HouseholdMember[];
  filingStatus: PlanningFilingStatus | null;
  effectiveFilingStatus: PlanningFilingStatus;
  filingStatusInherited: boolean;
}

/** A profile exactly as it was saved before household integration existed. */
const legacyRetirement = {
  people: [
    { id: 'p1', name: 'Justin', birthYear: 1978, pia: 2_400, annualEarnings: null, plannedClaimAge: 67 },
  ],
  balances: { taxable: 100_000, traditional: 400_000, roth: 50_000, hsa: 10_000 },
  settings: {
    filingStatus: 'married_joint',
    annualSpending: 70_000,
    horizonAge: 90,
    colaPct: 2.5,
    realReturnPct: 4,
    sequencingPreference: 'taxable_first',
  },
};

beforeEach(() => {
  state.stored = {};
  state.members = [];
  state.filingStatus = null;
  state.entityTablesMissing = false;
});

describe('loadHouseholdRoster', () => {
  it('returns household members with their birthdays', async () => {
    state.members = [{ role: 'self', name: 'Justin Crawford', birthday: '1978-04-02' }];
    expect(await loadHouseholdRoster(BOOK)).toEqual([
      { role: 'self', name: 'Justin Crawford', birthday: '1978-04-02' },
    ]);
  });

  it('returns an empty roster when the entity tables are missing', async () => {
    state.entityTablesMissing = true;
    expect(await loadHouseholdRoster(BOOK)).toEqual([]);
  });
});

describe('loadHouseholdFilingStatus', () => {
  it('maps the stored 1040 token onto the pack union', async () => {
    state.filingStatus = 'mfj';
    expect(await loadHouseholdFilingStatus(BOOK)).toBe('married_joint');
    state.filingStatus = 'hoh';
    expect(await loadHouseholdFilingStatus(BOOK)).toBe('single');
  });

  it('returns null when there is no entity profile row', async () => {
    expect(await loadHouseholdFilingStatus(BOOK)).toBeNull();
  });
});

describe('retirement income section', () => {
  it('seeds people from the household roster when the pack is empty', async () => {
    state.members = [
      { role: 'self', name: 'Justin Crawford', birthday: '1978-04-02' },
      { role: 'spouse', name: 'Cara Crawford', birthday: '1980-09-14' },
      { role: 'dependent', name: 'Rowan Crawford', birthday: '2012-01-20' },
    ];
    const result = await getResilienceSection(BOOK, 'retirement_income') as {
      profile: RetirementIncomeProfile;
      household: HouseholdContext;
    };
    expect(result.profile.people).toHaveLength(2);
    expect(result.profile.people[0]).toMatchObject({
      memberRole: 'self',
      name: 'Justin Crawford',
      birthYear: 1978,
      pia: 0,
      plannedClaimAge: 67,
    });
    // The full roster (dependents included) is offered to the member picker.
    expect(result.household.members).toHaveLength(3);
  });

  it('resolves a linked person against the roster, roster values winning', async () => {
    state.members = [{ role: 'spouse', name: 'Cara Crawford', birthday: '1980-09-14' }];
    await saveResilienceProfile({
      bookGuid: BOOK,
      userId: 1,
      section: 'retirement_income',
      data: {
        ...legacyRetirement,
        people: [{ ...legacyRetirement.people[0], memberRole: 'spouse', name: 'Stale', birthYear: 1965 }],
      },
    });
    const result = await getResilienceSection(BOOK, 'retirement_income') as {
      profile: RetirementIncomeProfile;
    };
    expect(result.profile.people[0]).toMatchObject({ name: 'Cara Crawford', birthYear: 1980 });
  });

  it('inherits the household filing status without freezing it into the profile', async () => {
    state.filingStatus = 'single';
    await saveResilienceProfile({
      bookGuid: BOOK,
      userId: 1,
      section: 'retirement_income',
      data: { ...legacyRetirement, settings: { ...legacyRetirement.settings, filingStatus: null } },
    });
    const result = await getResilienceSection(BOOK, 'retirement_income') as {
      profile: RetirementIncomeProfile;
      analysis: { settings: { filingStatus: PlanningFilingStatus | null } };
      household: HouseholdContext;
    };
    // Stored value stays null so the pack keeps following Settings…
    expect(result.profile.settings.filingStatus).toBeNull();
    // …while the engine actually ran on the resolved value.
    expect(result.analysis.settings.filingStatus).toBe('single');
    expect(result.household).toMatchObject({
      filingStatus: 'single',
      effectiveFilingStatus: 'single',
      filingStatusInherited: true,
    });
  });

  it('lets an explicit pack override beat household settings', async () => {
    state.filingStatus = 'single';
    await saveResilienceProfile({
      bookGuid: BOOK,
      userId: 1,
      section: 'retirement_income',
      data: legacyRetirement,
    });
    const result = await getResilienceSection(BOOK, 'retirement_income') as {
      analysis: { settings: { filingStatus: PlanningFilingStatus | null } };
      household: HouseholdContext;
    };
    expect(result.analysis.settings.filingStatus).toBe('married_joint');
    expect(result.household.filingStatusInherited).toBe(false);
  });

  it('round-trips a legacy profile unchanged with no household configured', async () => {
    const saved = await saveResilienceProfile({
      bookGuid: BOOK,
      userId: 1,
      section: 'retirement_income',
      data: legacyRetirement,
    }) as RetirementIncomeProfile;
    // memberRole is absent, not invented; every stored value survives.
    expect(saved.people[0]).toMatchObject({ name: 'Justin', birthYear: 1978, pia: 2_400 });
    expect(saved.people[0].memberRole ?? null).toBeNull();
    expect(saved.settings.filingStatus).toBe('married_joint');

    const result = await getResilienceSection(BOOK, 'retirement_income') as {
      profile: RetirementIncomeProfile;
      analysis: { people: Array<{ name: string; birthYear: number }> };
    };
    expect(result.profile.people[0]).toMatchObject({ name: 'Justin', birthYear: 1978 });
    expect(result.analysis.people[0]).toMatchObject({ name: 'Justin', birthYear: 1978 });
  });

  it('leaves the pack empty when no household members are configured', async () => {
    const result = await getResilienceSection(BOOK, 'retirement_income') as {
      profile: RetirementIncomeProfile;
      household: HouseholdContext;
    };
    expect(result.profile.people).toEqual([]);
    expect(result.household).toMatchObject({
      members: [],
      filingStatus: null,
      // No household value: the pack keeps the default it has always used.
      effectiveFilingStatus: 'married_joint',
    });
  });
});

describe('life insurance section', () => {
  it('seeds people from the roster and resolves linked names', async () => {
    state.members = [
      { role: 'self', name: 'Justin Crawford', birthday: '1978-04-02' },
      { role: 'spouse', name: 'Cara Crawford', birthday: '1980-09-14' },
    ];
    const seeded = await getResilienceSection(BOOK, 'life') as {
      profile: LifeProfile;
      household: HouseholdContext;
    };
    expect(seeded.profile.people.map(person => person.name)).toEqual(['Justin Crawford', 'Cara Crawford']);
    expect(seeded.household.members).toHaveLength(2);

    await saveResilienceProfile({
      bookGuid: BOOK,
      userId: 1,
      section: 'life',
      data: {
        people: [{
          id: 'l1',
          memberRole: 'spouse',
          name: 'Stale Name',
          annualIncome: 90_000,
          replacementYears: 10,
          debts: 250_000,
          educationGoals: 0,
          finalExpenses: 20_000,
          liquidAssets: 0,
          existingCoverage: 100_000,
          survivorAnnualIncome: 30_000,
          survivorAnnualExpenses: 70_000,
        }],
      },
    });
    const result = await getResilienceSection(BOOK, 'life') as {
      profile: LifeProfile;
      analyses: Array<{ recommendedCoverage: number }>;
    };
    expect(result.profile.people[0].name).toBe('Cara Crawford');
    // DIME/survivor math is untouched: 250k debts + 900k replacement + 20k final
    // − 100k coverage = 1,070,000.
    expect(result.analyses[0].recommendedCoverage).toBe(1_070_000);
  });

  it('keeps a legacy person (no memberRole) exactly as stored', async () => {
    state.members = [{ role: 'self', name: 'Justin Crawford', birthday: '1978-04-02' }];
    await saveResilienceProfile({
      bookGuid: BOOK,
      userId: 1,
      section: 'life',
      data: {
        people: [{
          id: 'l1',
          name: 'Manually Entered',
          annualIncome: 50_000,
          replacementYears: 5,
          debts: 0,
          educationGoals: 0,
          finalExpenses: 0,
          liquidAssets: 0,
          existingCoverage: 0,
          survivorAnnualIncome: 0,
          survivorAnnualExpenses: 0,
        }],
      },
    });
    const result = await getResilienceSection(BOOK, 'life') as { profile: LifeProfile };
    expect(result.profile.people[0].name).toBe('Manually Entered');
  });
});

describe('education / 529 section', () => {
  const student = {
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
  };

  it('seeds one student per named household dependent', async () => {
    state.members = [
      { role: 'self', name: 'Justin Crawford', birthday: '1978-04-02' },
      { role: 'dependent', name: 'Rowan Crawford', birthday: '2012-01-20' },
      { role: 'dependent', name: 'Sage Crawford', birthday: '2015-06-11' },
    ];
    const result = await getResilienceSection(BOOK, 'education') as {
      profile: EducationProfile;
      plans: Array<{ id: string; projectedCost: number }>;
      household: HouseholdContext;
    };
    expect(result.profile.children.map(child => child.name)).toEqual(['Rowan Crawford', 'Sage Crawford']);
    expect(result.profile.children[0]).toMatchObject({
      id: 'household-dependent-rowan-crawford',
      memberRole: 'dependent',
      birthYear: 2012,
      collegeStartYear: 2030,
    });
    // Plans are computed for the seeded students, so the page is useful at once.
    expect(result.plans).toHaveLength(2);
    expect(result.household.members).toHaveLength(3);
  });

  it('resolves a linked student against the roster, roster values winning', async () => {
    state.members = [{ role: 'dependent', name: 'Rowan Crawford', birthday: '2012-01-20' }];
    await saveResilienceProfile({
      bookGuid: BOOK,
      userId: 1,
      section: 'education',
      data: { children: [{ ...student, memberRole: 'dependent', memberName: 'Rowan Crawford' }] },
    });
    const result = await getResilienceSection(BOOK, 'education') as { profile: EducationProfile };
    expect(result.profile.children[0]).toMatchObject({
      name: 'Rowan Crawford',
      birthYear: 2012,
      // 529 inputs are never touched by resolution.
      current529Balance: 10_000,
      collegeStartYear: 2028,
    });
  });

  it('does not guess when two dependents share a name', async () => {
    state.members = [
      { role: 'dependent', name: 'Rowan Crawford', birthday: '2012-01-20' },
      { role: 'dependent', name: 'rowan crawford', birthday: '2014-03-05' },
    ];
    await saveResilienceProfile({
      bookGuid: BOOK,
      userId: 1,
      section: 'education',
      data: { children: [{ ...student, memberRole: 'dependent', memberName: 'Rowan Crawford' }] },
    });
    const result = await getResilienceSection(BOOK, 'education') as { profile: EducationProfile };
    expect(result.profile.children[0]).toMatchObject({ name: 'Stored Student', birthYear: 2010 });
  });

  it('round-trips a legacy student unchanged, even with a name-matching roster', async () => {
    state.members = [{ role: 'dependent', name: 'Stored Student', birthday: '2012-01-20' }];
    const saved = await saveResilienceProfile({
      bookGuid: BOOK,
      userId: 1,
      section: 'education',
      data: { children: [student] },
    }) as EducationProfile;
    expect(saved.children[0].memberRole ?? null).toBeNull();

    const result = await getResilienceSection(BOOK, 'education') as {
      profile: EducationProfile;
      plans: Array<{ name: string; projectedCost: number }>;
    };
    expect(result.profile.children[0]).toMatchObject({ name: 'Stored Student', birthYear: 2010 });
    expect(result.plans[0].name).toBe('Stored Student');
  });

  it('leaves the pack empty when no dependents are configured', async () => {
    state.members = [{ role: 'self', name: 'Justin Crawford', birthday: '1978-04-02' }];
    const result = await getResilienceSection(BOOK, 'education') as {
      profile: EducationProfile;
    };
    expect(result.profile.children).toEqual([]);
  });
});

describe('giving section', () => {
  it('inherits the household filing status while the stored profile stays null', async () => {
    state.filingStatus = 'qss';
    const result = await getResilienceSection(BOOK, 'giving') as {
      profile: { settings: { filingStatus: PlanningFilingStatus | null } };
      plan: { settings: { filingStatus: PlanningFilingStatus | null } };
      household: HouseholdContext;
    };
    expect(result.profile.settings.filingStatus).toBeNull();
    expect(result.plan.settings.filingStatus).toBe('married_joint');
    expect(result.household).toMatchObject({ filingStatus: 'married_joint', filingStatusInherited: true });
  });
});
