import type { EstateDocumentKind, EstateMemberRole, EstateProfile } from './types';

/**
 * A household roster entry passed into the engine by the service layer.
 * The engine stays pure: it never reads the entity profile itself, exactly like
 * the giving pack takes its charity-mileage context as an argument.
 *
 * The service supplies `HouseholdMember` (see ./types), which is structurally
 * assignable to this. This declaration stays deliberately wider — it also
 * accepts business roles, which the engine simply ignores — so a caller can
 * hand it a raw, unfiltered member list without the roster silently changing
 * meaning.
 */
export interface EstateHouseholdMember {
  role: EstateMemberRole | 'owner' | 'officer';
  name: string;
}

/** Roles that need their own set of core estate documents. */
const ADULT_ROLES = ['self', 'spouse'] as const;
type AdultRole = (typeof ADULT_ROLES)[number];

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Federal estate and gift tax exemption per person for 2026 under OBBBA.
 * The repo has no other estate exemption module, so this is a local constant.
 */
export const FEDERAL_ESTATE_EXEMPTION_2026 = 15_000_000;
/** Top federal estate tax rate applied to the taxable excess. */
export const FEDERAL_ESTATE_TOP_RATE = 0.4;
/** Document kinds every estate plan is expected to have on file. */
export const CORE_DOCUMENT_KINDS = ['will', 'financial_poa', 'healthcare_poa', 'healthcare_directive'] as const;
/** Life events that should trigger a review of estate documents. */
export const DOCUMENT_TRIGGER_EVENT_KINDS = ['marriage', 'divorce', 'birth', 'death'] as const;
/** A survivor runbook older than this many years no longer counts as current. */
export const SURVIVOR_RUNBOOK_MAX_AGE_YEARS = 2;

const MS_PER_DAY = 86_400_000;

function dayValue(date: string): number {
  return new Date(`${date}T12:00:00Z`).getTime();
}

function daysBetween(from: string, to: string): number {
  return Math.round((dayValue(to) - dayValue(from)) / MS_PER_DAY);
}

function addYears(date: string, years: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCFullYear(value.getUTCFullYear() + years);
  return value.toISOString().slice(0, 10);
}

/**
 * Estate readiness.
 *
 * `roster` is the household roster (self / spouse / dependents) loaded by the
 * service layer. Core-document coverage is measured **per adult**: one spouse's
 * will does not satisfy the other's. Documents attributed to 'household' (a
 * joint revocable trust, for example) credit every adult. With an empty roster
 * the engine falls back to the original household-level behaviour so books with
 * no entity profile keep working unchanged.
 *
 * Score weighting (100 points):
 *   - 40 designations: share of beneficiary designations that are not stale.
 *   - 40 core documents: with a roster, the *average* per-adult share of the
 *     four core kinds that are on file, fresh, and not life-event triggered —
 *     so one adult missing a financial POA costs 40 × (1/4) / adults. With no
 *     roster, the household-level share of the four core kinds.
 *   - 20 survivor runbook: present and updated within two years.
 */
export function calculateEstateReadiness(
  profile: EstateProfile,
  asOf = new Date(),
  roster: EstateHouseholdMember[] = [],
) {
  const { settings } = profile;
  const asOfDate = asOf.toISOString().slice(0, 10);
  const pastEvents = profile.lifeEvents
    .filter(event => event.date <= asOfDate)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const latestLifeEvent = pastEvents.at(-1) ?? null;
  const latestTriggerEvent = pastEvents
    .filter(event => (DOCUMENT_TRIGGER_EVENT_KINDS as readonly string[]).includes(event.kind))
    .at(-1) ?? null;

  const designations = profile.designations.map(designation => {
    const staleByLifeEvent = latestLifeEvent != null && designation.lastReviewedDate < latestLifeEvent.date;
    const staleByAge = addYears(designation.lastReviewedDate, settings.reviewCycleYearsDefault) < asOfDate;
    const staleReason = staleByLifeEvent ? 'life_event' as const : staleByAge ? 'age' as const : null;
    return {
      ...designation,
      daysSinceReview: daysBetween(designation.lastReviewedDate, asOfDate),
      stale: staleReason != null,
      staleReason,
      triggeringLifeEvent: staleByLifeEvent ? latestLifeEvent : null,
    };
  });

  const documents = profile.documents.map(document => {
    const dueDate = addYears(document.lastUpdatedDate, document.reviewCycleYears);
    const lifeEventTrigger = latestTriggerEvent != null && document.lastUpdatedDate < latestTriggerEvent.date
      ? latestTriggerEvent
      : null;
    return {
      ...document,
      dueDate,
      overdue: dueDate < asOfDate,
      daysUntilDue: daysBetween(asOfDate, dueDate),
      lifeEventTrigger,
    };
  });

  const presentKinds = new Set(profile.documents.map(document => document.kind));

  // Adults needing their own document set, de-duplicated by role and in roster
  // order (self first). Business owner/officer rows are not household members.
  const adults: Array<{ role: AdultRole; name: string }> = [];
  for (const member of roster) {
    if (!(ADULT_ROLES as readonly string[]).includes(member.role)) continue;
    const role = member.role as AdultRole;
    if (adults.some(adult => adult.role === role)) continue;
    adults.push({ role, name: member.name });
  }

  const attributedTo = (documentRole: EstateMemberRole | undefined, role: AdultRole) =>
    documentRole == null || documentRole === 'household' || documentRole === role;

  /** Per-adult core coverage; empty when there is no roster. */
  const members = adults.map(adult => {
    const owned = documents.filter(document => attributedTo(document.memberRole, adult.role));
    const heldKinds = new Set(owned.map(document => document.kind));
    const freshKinds = new Set(
      owned.filter(document => !document.overdue && !document.lifeEventTrigger).map(document => document.kind),
    );
    const presentCoreDocuments = CORE_DOCUMENT_KINDS.filter(kind => heldKinds.has(kind));
    return {
      role: adult.role,
      name: adult.name,
      presentCoreDocuments,
      missingCoreDocuments: CORE_DOCUMENT_KINDS.filter(kind => !heldKinds.has(kind)),
      freshCoreCount: CORE_DOCUMENT_KINDS.filter(kind => freshKinds.has(kind)).length,
    };
  });

  const householdMissing = CORE_DOCUMENT_KINDS.filter(kind => !presentKinds.has(kind));
  const coverage = {
    /** Household rollup: kinds nobody has on file. Drives the summary copy. */
    missingCoreDocuments: householdMissing,
    // A revocable trust is noted for context but never required.
    hasRevocableTrust: presentKinds.has('revocable_trust'),
    /** Per-adult coverage; empty array when no roster was supplied. */
    members,
    /** Every (adult, kind) pair still missing — one Action Center item each. */
    missingByMember: members.flatMap(member =>
      member.missingCoreDocuments.map(kind => ({
        role: member.role,
        name: member.name,
        kind: kind as EstateDocumentKind,
      })),
    ),
  };

  const married = settings.maritalStatus === 'married';
  const exemptionApplied = FEDERAL_ESTATE_EXEMPTION_2026 * (married ? 2 : 1);
  const exposureAmount = round2(Math.max(0, settings.estimatedGrossEstate - exemptionApplied));
  const assumptions = [
    `Federal estate exemption ${FEDERAL_ESTATE_EXEMPTION_2026.toLocaleString('en-US')} per person for 2026 (OBBBA).`,
  ];
  if (married) {
    assumptions.push('Married exemption is doubled assuming the survivor elects portability (Form 706) for the deceased spouse\'s unused exclusion.');
  }
  if (settings.state === 'NC') {
    assumptions.push('North Carolina has no state estate or inheritance tax.');
  }
  const exposure = {
    grossEstate: round2(settings.estimatedGrossEstate),
    exemptionPerPerson: FEDERAL_ESTATE_EXEMPTION_2026,
    exemptionApplied,
    exposure: exposureAmount,
    topRatePct: round2(FEDERAL_ESTATE_TOP_RATE * 100),
    estimatedTax: round2(exposureAmount * FEDERAL_ESTATE_TOP_RATE),
    formula: 'exposure = max(0, gross estate − exemption × (2 if married with portability else 1)); estimated tax = exposure × 40%',
    assumptions,
  };

  const runbookLocation = settings.survivorRunbookLocation?.trim() || null;
  const runbookUpdated = settings.survivorRunbookUpdatedDate ?? null;
  const runbookCurrent = runbookLocation != null
    && runbookUpdated != null
    && addYears(runbookUpdated, SURVIVOR_RUNBOOK_MAX_AGE_YEARS) >= asOfDate;
  const runbook = {
    present: runbookLocation != null,
    location: runbookLocation,
    updatedDate: runbookUpdated,
    daysSinceUpdate: runbookUpdated != null ? daysBetween(runbookUpdated, asOfDate) : null,
    current: runbookCurrent,
  };

  const staleDesignationCount = designations.filter(designation => designation.stale).length;
  const missingCoreCount = adults.length > 0
    ? coverage.missingByMember.length
    : coverage.missingCoreDocuments.length;
  const documentIssueCount = documents.filter(document => document.overdue || document.lifeEventTrigger).length
    + missingCoreCount;

  const designationComponent = designations.length === 0
    ? 40
    : (designations.length - staleDesignationCount) / designations.length * 40;
  // With a roster the document component is the mean per-adult completeness;
  // without one it stays the household-level share of the four core kinds.
  const householdFreshCoreCount = CORE_DOCUMENT_KINDS
    .filter(kind => documents.some(document => document.kind === kind && !document.overdue && !document.lifeEventTrigger))
    .length;
  const coreCompleteness = adults.length > 0
    ? members.reduce((sum, member) => sum + member.freshCoreCount / CORE_DOCUMENT_KINDS.length, 0) / members.length
    : householdFreshCoreCount / CORE_DOCUMENT_KINDS.length;
  const documentComponent = coreCompleteness * 40;
  const runbookComponent = runbookCurrent ? 20 : 0;

  return {
    settings,
    asOfDate,
    designations,
    documents,
    coverage,
    exposure,
    runbook,
    staleDesignationCount,
    documentIssueCount,
    score: Math.round(designationComponent + documentComponent + runbookComponent),
  };
}
