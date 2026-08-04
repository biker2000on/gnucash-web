/**
 * Household identity for the resilience planning packs.
 *
 * The household roster (who the people are, and when they were born) lives in
 * household settings — `gnucash_web_entity_members`, surfaced by
 * `getEntityProfile` and `GET /api/entity`. Planning packs must not ask the
 * user to re-enter it. Instead each pack person carries a `memberRole` link and
 * this module resolves that link against the roster.
 *
 * Everything here is pure: the service layer loads the roster from the database
 * and passes it in, exactly like the estate pack's `calculateEstateReadiness`.
 * The engines themselves are never given database access.
 */

import type {
  EducationChild,
  EducationProfile,
  FamilyBankChild,
  FamilyBankingProfile,
  HealthcareClaim,
  HealthcareProfile,
  HouseholdMember,
  HouseholdRole,
  LifePerson,
  LifeProfile,
  PlanningFilingStatus,
  RetirementIncomeProfile,
  RetirementPerson,
} from './types';

/** Household roles, in the order they are seeded and displayed. */
export const HOUSEHOLD_ROLES: HouseholdRole[] = ['self', 'spouse', 'dependent'];

/** Roles seeded into an empty pack, in order. Dependents are not seeded. */
const SEED_ROLES: HouseholdRole[] = ['self', 'spouse'];

export const HOUSEHOLD_ROLE_LABELS: Record<HouseholdRole, string> = {
  self: 'Self',
  spouse: 'Spouse',
  dependent: 'Dependent',
};

/**
 * The filing status the packs used before household inheritance existed. A
 * `null` pack value that cannot be resolved from settings falls back to this,
 * so books with no entity profile keep their previous numbers.
 */
export const LEGACY_PACK_FILING_STATUS: PlanningFilingStatus = 'married_joint';

/** Birth year used when seeding a member who has no birthday on file. */
export const SEED_BIRTH_YEAR = 1965;

/** Planned Social Security claiming age applied to seeded people. */
export const SEED_PLANNED_CLAIM_AGE = 67;

/** Income replacement years applied to seeded life-insurance people. */
const SEED_REPLACEMENT_YEARS = 10;

/**
 * Years from birth to the first year of college, used to derive a seeded
 * student's `collegeStartYear` from their household birthday.
 */
export const COLLEGE_START_AGE = 18;

/**
 * Defaults for a seeded 529 student. Deliberately identical to what the
 * "Add student" button creates, so a seeded row and a hand-added row are
 * indistinguishable once the user starts editing.
 */
const EDUCATION_SEED_DEFAULTS = {
  schoolType: 'public_in_state',
  yearsOfSchool: 4,
  annualCostToday: 30_000,
  tuitionInflationRate: 5,
  current529Balance: 0,
  expectedAnnualReturn: 6,
  plannedMonthlyContribution: 250,
  stateDeductionLimit: 0,
} as const;

/**
 * Defaults for a seeded family-banking child. Identical to what the "Add
 * child" button creates, so a seeded row and a hand-added row are
 * indistinguishable once the user starts editing.
 */
const FAMILY_BANK_SEED_DEFAULTS = {
  liabilityAccountGuid: '',
  allowanceAmount: 5,
  allowanceCadence: 'weekly',
  parentMatchPercent: 0,
  savingsGoal: 100,
} as const;

/**
 * Days ahead the first allowance of a seeded family-banking child is dated.
 * Seeding runs on every read until the user saves, so dating it "today" (the
 * Add-child default) would make a never-configured pack raise an "allowance
 * due" action the moment the household gains a dependent.
 */
export const FAMILY_BANK_SEED_ALLOWANCE_LEAD_DAYS = 7;

/**
 * Normalize a person's name for comparison: lowercase, single-spaced, no
 * punctuation. Shared with the estate pack's `matchEstateMemberRole` so that
 * "Rowan Crawford", "rowan  crawford" and "Rowan Crawford." all match.
 */
export function normalizePersonName(value: string): string {
  return value.toLowerCase().replace(/[.,'’]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Map a 1040 filing status from household settings onto the two-way union the
 * planning packs model.
 *
 * Canonical entity tokens are `FILING_STATUSES` from `@/lib/tax/types`:
 * 'single' | 'mfj' | 'mfs' | 'hoh' | 'qss'.
 *
 * - 'mfj' and 'qss' file on the joint brackets and standard deduction.
 * - 'single', 'mfs', and 'hoh' are all non-joint. MFS uses the single brackets
 *   outright; HOH sits between the two but is far closer to single than to
 *   joint on every threshold these packs touch (standard deduction, IRMAA,
 *   bracket edges), so it maps to 'single' rather than silently doubling them.
 * - Anything unrecognised (including null/empty) returns null, and the caller
 *   keeps the pack's own default.
 */
export function mapEntityFilingStatus(value: string | null | undefined): PlanningFilingStatus | null {
  switch (value?.trim().toLowerCase()) {
    case 'mfj':
    case 'qss':
      return 'married_joint';
    case 'single':
    case 'mfs':
    case 'hoh':
      return 'single';
    default:
      return null;
  }
}

/**
 * Effective filing status for a pack.
 *
 * Precedence: explicit pack override → household settings → legacy default.
 */
export function resolveFilingStatus(
  packValue: PlanningFilingStatus | null | undefined,
  householdValue: PlanningFilingStatus | null | undefined,
): PlanningFilingStatus {
  return packValue ?? householdValue ?? LEGACY_PACK_FILING_STATUS;
}

/** Birth year from an ISO birthday, or null when absent or unparseable. */
export function birthYearFromBirthday(birthday: string | null | undefined): number | null {
  if (!birthday) return null;
  const year = Number(birthday.slice(0, 4));
  return Number.isInteger(year) && year >= 1900 && year <= 2300 ? year : null;
}

/**
 * Age in whole years at `asOf` from an ISO birthday, or null when absent or
 * unparseable. Used wherever a pack needs an age for a linked member — the
 * family banking pack shows it next to each child — so the birthday recorded
 * once in Settings is the single source.
 */
export function ageFromBirthday(birthday: string | null | undefined, asOf = new Date()): number | null {
  if (birthYearFromBirthday(birthday) == null) return null;
  const month = Number(birthday!.slice(5, 7));
  const day = Number(birthday!.slice(8, 10));
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31) {
    return null;
  }
  const years = asOf.getUTCFullYear() - Number(birthday!.slice(0, 4));
  const hadBirthdayThisYear = asOf.getUTCMonth() + 1 > month
    || (asOf.getUTCMonth() + 1 === month && asOf.getUTCDate() >= day);
  const age = hadBirthdayThisYear ? years : years - 1;
  return age >= 0 ? age : null;
}

/**
 * First roster entry for a role. At most one 'self' and one 'spouse' exist
 * (enforced by `saveEntityProfile`); dependents match the first one listed.
 */
export function findRosterMember(
  roster: HouseholdMember[],
  role: HouseholdRole | null | undefined,
): HouseholdMember | null {
  if (!role) return null;
  return roster.find(member => member.role === role) ?? null;
}

/** Display name for a linked person: roster name → stored name → role label. */
function displayName(stored: string, member: HouseholdMember | null, role: HouseholdRole | null): string {
  const fromRoster = member?.name.trim();
  if (fromRoster) return fromRoster;
  const fromProfile = stored.trim();
  if (fromProfile) return fromProfile;
  return role ? HOUSEHOLD_ROLE_LABELS[role] : '';
}

/**
 * Resolve one retirement person against the roster.
 *
 * Precedence for both name and birth year: the linked household member's value
 * → the value stored in the pack → the pack's own default. A person with no
 * `memberRole` (every profile saved before this existed) is returned unchanged.
 */
export function resolveRetirementPerson(
  person: RetirementPerson,
  roster: HouseholdMember[],
): RetirementPerson {
  const role = person.memberRole ?? null;
  const member = findRosterMember(roster, role);
  if (!member) return person;
  return {
    ...person,
    name: displayName(person.name, member, role),
    birthYear: birthYearFromBirthday(member.birthday) ?? person.birthYear,
  };
}

/** Resolve one life-insurance person against the roster (name only). */
export function resolveLifePerson(person: LifePerson, roster: HouseholdMember[]): LifePerson {
  const role = person.memberRole ?? null;
  const member = findRosterMember(roster, role);
  if (!member) return person;
  return { ...person, name: displayName(person.name, member, role) };
}

/** Roster members eligible for seeding, in order, deduplicated by role. */
function seedableMembers(roster: HouseholdMember[]): HouseholdMember[] {
  return SEED_ROLES
    .map(role => findRosterMember(roster, role))
    .filter((member): member is HouseholdMember => member != null);
}

/**
 * Deterministic id for a seeded person. Seeding runs on every read until the
 * user saves, so a random id would churn React keys and analysis ids.
 */
function seedId(role: HouseholdRole): string {
  return `household-${role}`;
}

/**
 * Retirement income profile with people resolved against the roster.
 *
 * When the profile has no people and the household does, the roster seeds them
 * (self, then spouse) so the page is immediately useful rather than empty. The
 * seeded rows are ordinary editable people — nothing is persisted until save.
 */
export function resolveRetirementIncomeProfile(
  profile: RetirementIncomeProfile,
  roster: HouseholdMember[],
): RetirementIncomeProfile {
  if (profile.people.length === 0) {
    const seeded = seedableMembers(roster).map<RetirementPerson>(member => ({
      id: seedId(member.role),
      memberRole: member.role,
      name: displayName('', member, member.role),
      birthYear: birthYearFromBirthday(member.birthday) ?? SEED_BIRTH_YEAR,
      pia: 0,
      annualEarnings: null,
      plannedClaimAge: SEED_PLANNED_CLAIM_AGE,
    }));
    return seeded.length === 0 ? profile : { ...profile, people: seeded };
  }
  return { ...profile, people: profile.people.map(person => resolveRetirementPerson(person, roster)) };
}

/**
 * Life-insurance profile with people resolved against the roster, seeding
 * self and spouse when the pack is empty. Only the name comes from the
 * household — every financial input stays pack-specific.
 */
export function resolveLifeProfile(profile: LifeProfile, roster: HouseholdMember[]): LifeProfile {
  if (profile.people.length === 0) {
    const seeded = seedableMembers(roster).map<LifePerson>(member => ({
      id: seedId(member.role),
      memberRole: member.role,
      name: displayName('', member, member.role),
      annualIncome: 0,
      replacementYears: SEED_REPLACEMENT_YEARS,
      debts: 0,
      educationGoals: 0,
      finalExpenses: 0,
      liquidAssets: 0,
      existingCoverage: 0,
      survivorAnnualIncome: 0,
      survivorAnnualExpenses: 0,
    }));
    return seeded.length === 0 ? profile : { ...profile, people: seeded };
  }
  return { ...profile, people: profile.people.map(person => resolveLifePerson(person, roster)) };
}

/**
 * Find the one dependent this student refers to.
 *
 * 'dependent' is not unique, and the entity API has no stable per-member id, so
 * the link is role + name. The stored `memberName` (or `name` when that is
 * absent) is compared against every *named* dependent after normalization.
 *
 * A match is only returned when exactly one dependent matches. Zero matches
 * (the roster row was renamed or removed) and several matches (two dependents
 * genuinely share a name) both return null, and the caller keeps the stored
 * values rather than guessing which child is which.
 */
export function findDependentMember(
  child: Pick<EducationChild, 'memberRole' | 'memberName' | 'name'>,
  roster: HouseholdMember[],
): HouseholdMember | null {
  if (child.memberRole !== 'dependent') return null;
  const target = normalizePersonName(child.memberName?.trim() || child.name);
  if (!target) return null;
  const matches = roster.filter(member =>
    member.role === 'dependent'
    && member.name.trim()
    && normalizePersonName(member.name) === target);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Resolve one student against the roster.
 *
 * Precedence, identical to the retirement and life packs: the linked household
 * member's value → the value stored in the pack → the pack's own default. A
 * student with no `memberRole` (every profile saved before this existed) is
 * returned unchanged, as is one whose link is ambiguous or unmatched.
 */
export function resolveEducationChild(
  child: EducationChild,
  roster: HouseholdMember[],
): EducationChild {
  const member = findDependentMember(child, roster);
  if (!member) return child;
  return {
    ...child,
    name: displayName(child.name, member, 'dependent'),
    memberName: member.name.trim() || child.memberName || null,
    birthYear: birthYearFromBirthday(member.birthday) ?? child.birthYear,
  };
}

/**
 * Deterministic id for a row seeded from a dependent (529 students, family
 * banking children). Dependents have no stable id, so the normalized name is
 * the key — repeated reads must produce the same id or React keys and analysis
 * ids churn on every refresh.
 */
function dependentSeedId(name: string): string {
  return `household-dependent-${normalizePersonName(name).replace(/\s+/g, '-')}`;
}

/**
 * Education profile with students resolved against the roster, seeding one
 * student per *named* household dependent when the pack is empty.
 *
 * Nameless dependents are skipped: the link key is the name, so a nameless row
 * could never be resolved back and would seed an orphan.
 *
 * A known birthday sets both `birthYear` and `collegeStartYear`
 * (birth year + 18); without one, the pack's usual new-student defaults apply.
 */
export function resolveEducationProfile(
  profile: EducationProfile,
  roster: HouseholdMember[],
  asOf = new Date(),
): EducationProfile {
  if (profile.children.length === 0) {
    const currentYear = asOf.getUTCFullYear();
    const seeded = roster
      .filter(member => member.role === 'dependent' && member.name.trim())
      .map<EducationChild>(member => {
        const birthYear = birthYearFromBirthday(member.birthday);
        return {
          id: dependentSeedId(member.name),
          memberRole: 'dependent',
          memberName: member.name.trim(),
          name: member.name.trim(),
          birthYear: birthYear ?? currentYear - 5,
          collegeStartYear: birthYear != null ? birthYear + COLLEGE_START_AGE : currentYear + 13,
          ...EDUCATION_SEED_DEFAULTS,
          contributions: [],
        };
      });
    return seeded.length === 0 ? profile : { ...profile, children: seeded };
  }
  return { ...profile, children: profile.children.map(child => resolveEducationChild(child, roster)) };
}

/**
 * Resolve one healthcare claim against the roster.
 *
 * 'self' and 'spouse' link by role alone (they are unique); 'dependent' links
 * by role + normalized `member` name through the same strict matcher the 529
 * pack uses, so an ambiguous or missing match keeps the stored text rather
 * than guessing. A claim with no `memberRole` (every claim saved before this
 * existed) is returned unchanged. Only the display name resolves — the date,
 * category, and allowed amount are claim facts, never household data.
 */
export function resolveHealthcareClaim(
  claim: HealthcareClaim,
  roster: HouseholdMember[],
): HealthcareClaim {
  const role = claim.memberRole ?? null;
  if (!role) return claim;
  const member = role === 'dependent'
    ? findDependentMember({ memberRole: role, memberName: claim.member, name: claim.member }, roster)
    : findRosterMember(roster, role);
  if (!member) return claim;
  return { ...claim, member: displayName(claim.member, member, role) };
}

/**
 * Healthcare profile with claim members resolved against the roster.
 *
 * Claims are historical facts, so nothing is seeded when the pack is empty —
 * the roster itself seeds the *member options* the page offers instead. Plans
 * and the current-plan choice pass through untouched.
 */
export function resolveHealthcareProfile(
  profile: HealthcareProfile,
  roster: HouseholdMember[],
): HealthcareProfile {
  if (profile.claims.length === 0) return profile;
  return { ...profile, claims: profile.claims.map(claim => resolveHealthcareClaim(claim, roster)) };
}

/**
 * Employer-plan eligibility context for the healthcare comparator, from
 * `EntityMember.coveredByEmployerPlan` in household settings. Only members
 * whose coverage is actually recorded appear — a roster loaded without the
 * flag contributes nothing, so the comparator never invents eligibility.
 */
export interface EmployerPlanCoverage {
  /** Display names of members covered by an employer plan. */
  covered: string[];
  /** Display names of members recorded as not covered. */
  notCovered: string[];
}

export function employerPlanCoverage(roster: HouseholdMember[]): EmployerPlanCoverage {
  const coverage: EmployerPlanCoverage = { covered: [], notCovered: [] };
  for (const member of roster) {
    if (member.coveredByEmployerPlan == null) continue;
    const name = member.name.trim() || HOUSEHOLD_ROLE_LABELS[member.role];
    (member.coveredByEmployerPlan ? coverage.covered : coverage.notCovered).push(name);
  }
  return coverage;
}

/**
 * Resolve one family-banking child against the roster.
 *
 * Same strict dependent matcher as the 529 pack: role + normalized name,
 * resolved only when exactly one dependent matches. A child with no
 * `memberRole` (every ledger saved before this existed) is returned unchanged,
 * as is one whose link is ambiguous or unmatched. Only identity resolves —
 * the ledger, allowance schedule, and goals are pack data.
 */
export function resolveFamilyBankChild(
  child: FamilyBankChild,
  roster: HouseholdMember[],
): FamilyBankChild {
  const member = findDependentMember(child, roster);
  if (!member) return child;
  return {
    ...child,
    name: displayName(child.name, member, 'dependent'),
    memberName: member.name.trim() || child.memberName || null,
  };
}

/**
 * Family banking profile with children resolved against the roster, seeding
 * one ledger per *named* household dependent when the pack is empty — every
 * child ledger corresponds to a dependent, so the page starts with the right
 * names instead of a blank list. Nameless dependents are skipped: the link key
 * is the name, so a nameless row could never be resolved back.
 */
export function resolveFamilyBankingProfile(
  profile: FamilyBankingProfile,
  roster: HouseholdMember[],
  asOf = new Date(),
): FamilyBankingProfile {
  if (profile.children.length === 0) {
    const firstAllowance = new Date(asOf.getTime() + FAMILY_BANK_SEED_ALLOWANCE_LEAD_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const seeded = roster
      .filter(member => member.role === 'dependent' && member.name.trim())
      .map<FamilyBankChild>(member => ({
        id: dependentSeedId(member.name),
        memberRole: 'dependent',
        memberName: member.name.trim(),
        name: member.name.trim(),
        nextAllowanceDate: firstAllowance,
        ...FAMILY_BANK_SEED_DEFAULTS,
        entries: [],
      }));
    return seeded.length === 0 ? profile : { ...profile, children: seeded };
  }
  return { ...profile, children: profile.children.map(child => resolveFamilyBankChild(child, roster)) };
}

/**
 * Copy of a pack profile with its filing status resolved to a concrete value
 * for the engine. The *stored* profile keeps its `null`, so the UI still shows
 * "inherit from household settings" and a save does not silently freeze the
 * inherited value into a per-pack override.
 */
export function withResolvedFilingStatus<
  P extends { settings: { filingStatus: PlanningFilingStatus | null } },
>(profile: P, householdFilingStatus: PlanningFilingStatus | null): P {
  return {
    ...profile,
    settings: {
      ...profile.settings,
      filingStatus: resolveFilingStatus(profile.settings.filingStatus, householdFilingStatus),
    },
  };
}
