import type { EstateProfile } from './types';

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

export function calculateEstateReadiness(profile: EstateProfile, asOf = new Date()) {
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
  const coverage = {
    missingCoreDocuments: CORE_DOCUMENT_KINDS.filter(kind => !presentKinds.has(kind)),
    // A revocable trust is noted for context but never required.
    hasRevocableTrust: presentKinds.has('revocable_trust'),
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
  const documentIssueCount = documents.filter(document => document.overdue || document.lifeEventTrigger).length
    + coverage.missingCoreDocuments.length;

  const designationComponent = designations.length === 0
    ? 40
    : (designations.length - staleDesignationCount) / designations.length * 40;
  const freshCoreCount = CORE_DOCUMENT_KINDS
    .filter(kind => documents.some(document => document.kind === kind && !document.overdue && !document.lifeEventTrigger))
    .length;
  const documentComponent = freshCoreCount / CORE_DOCUMENT_KINDS.length * 40;
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
