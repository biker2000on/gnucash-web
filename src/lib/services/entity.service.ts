/**
 * Entity Profile Service
 *
 * Each GnuCash book belongs to an entity — a household (personal 1040 filers,
 * including spouse for per-spouse IRA limits) or a business (S-Corp, LLC,
 * sole proprietorship, C-Corp, 501(c)(3) nonprofit). The profile is consumed
 * by the tax estimator (filing mode per entity type), contribution tracking
 * (per-spouse limits), and future features.
 *
 * Backed by gnucash_web_entity_profiles + gnucash_web_entity_members
 * (see src/lib/db-init.ts). When no profile row exists, a household profile
 * is synthesized from user preferences so existing installs keep working.
 */

import prisma from '@/lib/prisma';
import { getPreference } from '@/lib/user-preferences';

export type EntityType =
  | 'household'
  | 'sole_prop'
  | 'llc_single'
  | 'llc_partnership'
  | 's_corp'
  | 'c_corp'
  | 'nonprofit_501c3';

export type EntityMemberRole = 'self' | 'spouse' | 'dependent' | 'owner' | 'officer';

export const ENTITY_TYPES: EntityType[] = [
  'household',
  'sole_prop',
  'llc_single',
  'llc_partnership',
  's_corp',
  'c_corp',
  'nonprofit_501c3',
];

export const ENTITY_MEMBER_ROLES: EntityMemberRole[] = [
  'self',
  'spouse',
  'dependent',
  'owner',
  'officer',
];

export interface EntityMember {
  role: EntityMemberRole;
  name: string | null;
  /** ISO date string (YYYY-MM-DD) or null. */
  birthday: string | null;
  coveredByEmployerPlan: boolean;
  /** For business owners; 0-100. */
  ownershipPercent: number | null;
  sortOrder: number;
}

export interface EntityProfile {
  entityType: EntityType;
  entityName: string | null;
  taxState: string | null;
  notes: string | null;
  members: EntityMember[];
  /** True when no profile row exists and this was built from user preferences. */
  synthesized: boolean;
}

/** Thrown for caller-fixable input problems; API routes map this to HTTP 400. */
export class EntityValidationError extends Error {}

/**
 * Full years of age for a member as of the given date (default: today).
 * Returns null when the birthday is unset or unparseable.
 */
export function memberAge(birthday: string | null, asOf: Date = new Date()): number | null {
  if (!birthday) return null;
  const [y, m, d] = birthday.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  let age = asOf.getFullYear() - y;
  const beforeBirthday =
    asOf.getMonth() + 1 < m || (asOf.getMonth() + 1 === m && asOf.getDate() < d);
  if (beforeBirthday) age -= 1;
  return age >= 0 ? age : null;
}

/** Display order: self first, then spouse, then everyone else. */
const ROLE_SORT_RANK: Record<EntityMemberRole, number> = {
  self: 0,
  spouse: 1,
  dependent: 2,
  owner: 2,
  officer: 2,
};

/** Sort members: self, spouse, then remaining roles by sort_order, then birthday. */
function sortMembers(members: EntityMember[]): EntityMember[] {
  return [...members].sort((a, b) => {
    const rank = (ROLE_SORT_RANK[a.role] ?? 2) - (ROLE_SORT_RANK[b.role] ?? 2);
    if (rank !== 0) return rank;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return (a.birthday ?? '9999-12-31').localeCompare(b.birthday ?? '9999-12-31');
  });
}

function toIsoDate(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function parseBirthday(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (isNaN(d.getTime())) {
    throw new EntityValidationError(`Invalid birthday: ${value}`);
  }
  return d;
}

/**
 * Synthesize a household profile from the user's tax preferences.
 * Used when the book has no persisted entity profile yet.
 */
async function synthesizeHouseholdProfile(userId: number): Promise<EntityProfile> {
  const [birthday, coveredSelf, spouseBirthday, coveredSpouse, filingStatus] =
    await Promise.all([
      getPreference<string | null>(userId, 'birthday', null),
      getPreference<boolean>(userId, 'tax_covered_by_employer_plan', true),
      getPreference<string | null>(userId, 'spouse_birthday', null),
      getPreference<boolean>(userId, 'tax_spouse_covered_by_employer_plan', false),
      getPreference<string | null>(userId, 'tax_filing_status', null),
    ]);

  const members: EntityMember[] = [
    {
      role: 'self',
      name: null,
      birthday: birthday ? birthday.slice(0, 10) : null,
      coveredByEmployerPlan: coveredSelf,
      ownershipPercent: null,
      sortOrder: 0,
    },
  ];

  const hasSpouse =
    Boolean(spouseBirthday) || filingStatus === 'mfj' || filingStatus === 'qss';
  if (hasSpouse) {
    members.push({
      role: 'spouse',
      name: null,
      birthday: spouseBirthday ? spouseBirthday.slice(0, 10) : null,
      coveredByEmployerPlan: coveredSpouse,
      ownershipPercent: null,
      sortOrder: 1,
    });
  }

  return {
    entityType: 'household',
    entityName: null,
    taxState: null,
    notes: null,
    members,
    synthesized: true,
  };
}

/**
 * Get the entity profile for a book. Falls back to a synthesized household
 * profile (from user preferences) when no profile row exists; the result is
 * marked `synthesized: true` so callers know it isn't persisted.
 */
export async function getEntityProfile(
  bookGuid: string,
  userId: number
): Promise<EntityProfile> {
  const profile = await prisma.gnucash_web_entity_profiles.findUnique({
    where: { book_guid: bookGuid },
  });

  if (!profile) {
    return synthesizeHouseholdProfile(userId);
  }

  const members = await prisma.gnucash_web_entity_members.findMany({
    where: { book_guid: bookGuid },
    orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
  });

  return {
    entityType: profile.entity_type as EntityType,
    entityName: profile.entity_name,
    taxState: profile.tax_state,
    notes: profile.notes,
    members: sortMembers(
      members.map((m) => ({
        role: m.role as EntityMemberRole,
        name: m.name,
        birthday: toIsoDate(m.birthday),
        coveredByEmployerPlan: m.covered_by_employer_plan,
        ownershipPercent: m.ownership_percent,
        sortOrder: m.sort_order,
      }))
    ),
    synthesized: false,
  };
}

export interface SaveEntityProfileInput {
  entityType: EntityType;
  entityName?: string | null;
  taxState?: string | null;
  notes?: string | null;
  members: Array<{
    role: EntityMemberRole;
    name?: string | null;
    birthday?: string | null;
    coveredByEmployerPlan?: boolean;
    ownershipPercent?: number | null;
    sortOrder?: number;
  }>;
}

/**
 * Upsert the profile row and replace its members in a single transaction.
 * Enforces at most one 'self' and one 'spouse' member.
 */
export async function saveEntityProfile(
  bookGuid: string,
  input: SaveEntityProfileInput
): Promise<EntityProfile> {
  if (!ENTITY_TYPES.includes(input.entityType)) {
    throw new EntityValidationError(`Invalid entity type: ${input.entityType}`);
  }
  for (const member of input.members) {
    if (!ENTITY_MEMBER_ROLES.includes(member.role)) {
      throw new EntityValidationError(`Invalid member role: ${member.role}`);
    }
  }
  const selfCount = input.members.filter((m) => m.role === 'self').length;
  const spouseCount = input.members.filter((m) => m.role === 'spouse').length;
  if (selfCount > 1) {
    throw new EntityValidationError("At most one 'self' member is allowed");
  }
  if (spouseCount > 1) {
    throw new EntityValidationError("At most one 'spouse' member is allowed");
  }

  const memberRows = input.members.map((m, i) => ({
    book_guid: bookGuid,
    role: m.role,
    name: m.name?.trim() || null,
    birthday: parseBirthday(m.birthday ?? null),
    covered_by_employer_plan: m.coveredByEmployerPlan ?? false,
    ownership_percent: m.ownershipPercent ?? null,
    sort_order: m.sortOrder ?? i,
  }));

  await prisma.$transaction([
    prisma.gnucash_web_entity_profiles.upsert({
      where: { book_guid: bookGuid },
      create: {
        book_guid: bookGuid,
        entity_type: input.entityType,
        entity_name: input.entityName?.trim() || null,
        tax_state: input.taxState?.trim() || null,
        notes: input.notes?.trim() || null,
      },
      update: {
        entity_type: input.entityType,
        entity_name: input.entityName?.trim() || null,
        tax_state: input.taxState?.trim() || null,
        notes: input.notes?.trim() || null,
        updated_at: new Date(),
      },
    }),
    prisma.gnucash_web_entity_members.deleteMany({
      where: { book_guid: bookGuid },
    }),
    prisma.gnucash_web_entity_members.createMany({
      data: memberRows,
    }),
  ]);

  return {
    entityType: input.entityType,
    entityName: input.entityName?.trim() || null,
    taxState: input.taxState?.trim() || null,
    notes: input.notes?.trim() || null,
    members: sortMembers(
      memberRows.map((m) => ({
        role: m.role as EntityMemberRole,
        name: m.name,
        birthday: toIsoDate(m.birthday),
        coveredByEmployerPlan: m.covered_by_employer_plan,
        ownershipPercent: m.ownership_percent,
        sortOrder: m.sort_order,
      }))
    ),
    synthesized: false,
  };
}
