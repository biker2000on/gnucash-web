/**
 * Effective-dated entity status — pure, client-safe core.
 *
 * A book's entity has two facts that change over time and must not be
 * conflated:
 *
 *   - LEGAL FORM: what the state says it is (a single-member LLC, a
 *     corporation, a sole proprietorship, ...).
 *   - FEDERAL TAX CLASSIFICATION: how the IRS taxes it (disregarded /
 *     Schedule C, partnership, S-corp, C-corp, exempt, ...).
 *
 * An LLC that files Form 2553 is still legally an LLC but is taxed as an
 * S-corp from the election's effective date. Tax features must therefore ask
 * "what was this entity on date X / for tax year Y?" rather than read today's
 * value — a 2027 S election must not rewrite how 2026 is treated.
 *
 * History rows are stored in gnucash_web_entity_status_history (see
 * src/lib/services/entity-status.service.ts). A row is in effect from its
 * `effectiveFrom` until the next row begins. The EARLIEST row also applies
 * backwards ("since inception"), so every date resolves to a status.
 *
 * Schedule C vs Schedule F is NOT part of the classification: it stays
 * derived from the profile's `business_activity`, which is orthogonal.
 *
 * No database, no Next.js imports — safe for client components, API routes,
 * and the worker.
 */

import type { EntityType } from '@/lib/services/entity.service';

export type LegalForm =
  | 'household'
  | 'sole_prop'
  | 'llc_single_member'
  | 'llc_multi_member'
  | 'corporation'
  | 'nonprofit_corp';

export type TaxClassification =
  | 'individual'
  | 'disregarded'
  | 'partnership'
  | 's_corp'
  | 'c_corp'
  | 'exempt';

/** 2553 = S-corp election; 8832 = entity classification (check-the-box). */
export type ElectionForm = '2553' | '8832';

export const LEGAL_FORMS: LegalForm[] = [
  'household',
  'sole_prop',
  'llc_single_member',
  'llc_multi_member',
  'corporation',
  'nonprofit_corp',
];

export const TAX_CLASSIFICATIONS: TaxClassification[] = [
  'individual',
  'disregarded',
  'partnership',
  's_corp',
  'c_corp',
  'exempt',
];

export const ELECTION_FORMS: ElectionForm[] = ['2553', '8832'];

export const LEGAL_FORM_LABELS: Record<LegalForm, string> = {
  household: 'Household',
  sole_prop: 'Sole proprietorship',
  llc_single_member: 'Single-member LLC',
  llc_multi_member: 'Multi-member LLC',
  corporation: 'Corporation',
  nonprofit_corp: 'Nonprofit corporation',
};

export const TAX_CLASSIFICATION_LABELS: Record<TaxClassification, string> = {
  individual: 'Individual (Form 1040)',
  disregarded: 'Disregarded entity (Schedule C/F on the owner’s 1040)',
  partnership: 'Partnership (Form 1065)',
  s_corp: 'S-corporation (Form 1120-S)',
  c_corp: 'C-corporation (Form 1120)',
  exempt: 'Tax-exempt (Form 990)',
};

export const ELECTION_FORM_LABELS: Record<ElectionForm, string> = {
  '2553': 'Form 2553 (S-corporation election)',
  '8832': 'Form 8832 (entity classification election)',
};

/** Which tax classifications each legal form can legitimately have. */
export const VALID_CLASSIFICATIONS: Record<LegalForm, TaxClassification[]> = {
  household: ['individual'],
  sole_prop: ['disregarded'],
  llc_single_member: ['disregarded', 's_corp', 'c_corp'],
  llc_multi_member: ['partnership', 's_corp', 'c_corp'],
  corporation: ['c_corp', 's_corp'],
  nonprofit_corp: ['exempt'],
};

export function isLegalForm(value: unknown): value is LegalForm {
  return typeof value === 'string' && (LEGAL_FORMS as string[]).includes(value);
}

export function isTaxClassification(value: unknown): value is TaxClassification {
  return typeof value === 'string' && (TAX_CLASSIFICATIONS as string[]).includes(value);
}

export function isElectionForm(value: unknown): value is ElectionForm {
  return typeof value === 'string' && (ELECTION_FORMS as string[]).includes(value);
}

/** Null when the pair is valid, else a human-readable reason. */
export function statusPairError(
  legalForm: LegalForm,
  taxClassification: TaxClassification,
): string | null {
  if (VALID_CLASSIFICATIONS[legalForm].includes(taxClassification)) return null;
  return `A ${LEGAL_FORM_LABELS[legalForm].toLowerCase()} cannot be taxed as ${TAX_CLASSIFICATION_LABELS[taxClassification]}.`;
}

/* ------------------------------------------------------------------ */
/* Legacy EntityType mapping                                           */
/* ------------------------------------------------------------------ */

/**
 * The legacy single-field `entity_type` stays as the derived "current" value
 * (and as the key most rule sets switch on). Tax classification decides it,
 * except where the legal form is what distinguishes two legacy values.
 */
export function legacyEntityType(
  legalForm: LegalForm,
  taxClassification: TaxClassification,
): EntityType {
  switch (taxClassification) {
    case 'individual':
      return 'household';
    case 'disregarded':
      return legalForm === 'sole_prop' ? 'sole_prop' : 'llc_single';
    case 'partnership':
      return 'llc_partnership';
    case 's_corp':
      return 's_corp';
    case 'c_corp':
      return 'c_corp';
    case 'exempt':
      return 'nonprofit_501c3';
  }
}

/** Default (legal form, classification) for a legacy entity type. */
export function fromLegacyEntityType(entityType: EntityType): {
  legalForm: LegalForm;
  taxClassification: TaxClassification;
} {
  switch (entityType) {
    case 'household':
      return { legalForm: 'household', taxClassification: 'individual' };
    case 'sole_prop':
      return { legalForm: 'sole_prop', taxClassification: 'disregarded' };
    case 'llc_single':
      return { legalForm: 'llc_single_member', taxClassification: 'disregarded' };
    case 'llc_partnership':
      return { legalForm: 'llc_multi_member', taxClassification: 'partnership' };
    case 's_corp':
      return { legalForm: 'corporation', taxClassification: 's_corp' };
    case 'c_corp':
      return { legalForm: 'corporation', taxClassification: 'c_corp' };
    case 'nonprofit_501c3':
      return { legalForm: 'nonprofit_corp', taxClassification: 'exempt' };
  }
}

/**
 * Map a legacy type onto an existing status, keeping the legal form when it
 * is still compatible. Correcting a single-member LLC from `llc_single` to
 * `s_corp` yields "single-member LLC taxed as an S-corp", not a corporation.
 */
export function coerceLegacyEntityType(
  current: { legalForm: LegalForm } | null,
  entityType: EntityType,
): { legalForm: LegalForm; taxClassification: TaxClassification } {
  const fallback = fromLegacyEntityType(entityType);
  if (!current) return fallback;
  if (VALID_CLASSIFICATIONS[current.legalForm].includes(fallback.taxClassification)) {
    const candidate = {
      legalForm: current.legalForm,
      taxClassification: fallback.taxClassification,
    };
    // Only keep the legal form if it still maps back to the requested type
    // (disregarded + sole_prop vs llc is decided by the legal form).
    if (legacyEntityType(candidate.legalForm, candidate.taxClassification) === entityType) {
      return candidate;
    }
  }
  return fallback;
}

/* ------------------------------------------------------------------ */
/* Rows and resolution                                                 */
/* ------------------------------------------------------------------ */

/**
 * Effective date of a seeded / synthesized "since inception" row. It must
 * sort before any real change: seeding at, say, the profile's creation date
 * would let that seed override an election the user dates earlier. The UI
 * renders this date as "Since inception".
 */
export const INCEPTION_DATE = '1900-01-01';

export function isInceptionDate(iso: string): boolean {
  return iso === INCEPTION_DATE;
}

export interface EntityStatusRow {
  /** Null for a synthesized row (no history persisted yet). */
  id: number | null;
  /** ISO YYYY-MM-DD. */
  effectiveFrom: string;
  legalForm: LegalForm;
  taxClassification: TaxClassification;
  electionForm: ElectionForm | null;
  electionFiledOn: string | null;
  electionAcceptedOn: string | null;
  /** The user confirmed a mid-year effective date creates short tax years. */
  shortYearConfirmed: boolean;
  electionDocumentId: number | null;
  acceptanceDocumentId: number | null;
  notes: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}

/** Oldest first; ties broken by id so the order is stable. */
export function sortHistory<T extends Pick<EntityStatusRow, 'effectiveFrom' | 'id'>>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(
    (a, b) =>
      a.effectiveFrom.localeCompare(b.effectiveFrom) || (a.id ?? 0) - (b.id ?? 0),
  );
}

/**
 * The row in effect on `date`: the latest row starting on or before it. The
 * earliest row also covers every date before it (since inception). Null only
 * when there are no rows at all.
 */
export function resolveStatusAt<T extends EntityStatusRow>(
  rows: readonly T[],
  date: string,
): T | null {
  const sorted = sortHistory(rows);
  if (sorted.length === 0) return null;
  let current = sorted[0];
  for (const row of sorted) {
    if (row.effectiveFrom <= date) current = row;
    else break;
  }
  return current;
}

/** Stable identity of a status for "did anything change?" comparisons. */
export function statusSignature(row: Pick<EntityStatusRow, 'legalForm' | 'taxClassification'>): string {
  return `${row.legalForm}/${row.taxClassification}`;
}

export interface TaxYearSegment<T extends EntityStatusRow = EntityStatusRow> {
  /** First day of the segment (inclusive), ISO. */
  from: string;
  /** Last day of the segment (inclusive), ISO. */
  to: string;
  row: T;
}

export interface TaxYearStatus<T extends EntityStatusRow = EntityStatusRow> {
  year: number;
  /**
   * The status that governs the year's annual obligations. With a single
   * segment this is simply that status. With a mid-year change (short tax
   * years) it is the YEAR-END status; callers must surface `mixed` rather
   * than silently treat the whole year that way.
   */
  status: T | null;
  segments: TaxYearSegment<T>[];
  /** More than one classification applies within the calendar year. */
  mixed: boolean;
  /** Every mid-year change in this year was explicitly confirmed. */
  shortYearConfirmed: boolean;
}

function dayBefore(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * Every status segment within calendar tax year `year`. Consecutive rows with
 * the same legal form and classification merge into one segment (recording an
 * IRS acceptance, for example, is not a change in treatment).
 */
export function resolveTaxYear<T extends EntityStatusRow>(
  rows: readonly T[],
  year: number,
): TaxYearStatus<T> {
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const first = resolveStatusAt(rows, start);
  if (!first) {
    return { year, status: null, segments: [], mixed: false, shortYearConfirmed: true };
  }
  const segments: TaxYearSegment<T>[] = [{ from: start, to: end, row: first }];
  let confirmed = true;
  for (const row of sortHistory(rows)) {
    if (row.effectiveFrom <= start || row.effectiveFrom > end) continue;
    const last = segments[segments.length - 1];
    if (statusSignature(row) === statusSignature(last.row)) continue;
    last.to = dayBefore(row.effectiveFrom);
    segments.push({ from: row.effectiveFrom, to: end, row });
    if (!row.shortYearConfirmed) confirmed = false;
  }
  return {
    year,
    status: segments[segments.length - 1].row,
    segments,
    mixed: segments.length > 1,
    shortYearConfirmed: confirmed,
  };
}

/** True when the effective date is not the first day of a calendar year. */
export function isMidYear(effectiveFrom: string): boolean {
  return !effectiveFrom.endsWith('-01-01');
}

function yearSignature(rows: readonly EntityStatusRow[], year: number): string {
  const resolved = resolveTaxYear(rows, year);
  return resolved.segments
    .map((s) => `${s.from}..${s.to}:${statusSignature(s.row)}`)
    .join('|');
}

/**
 * Tax years whose treatment differs between two histories — what a
 * correction, deletion, or new change will alter. Only years in
 * [fromYear, toYear] are compared.
 */
export function affectedTaxYears(
  before: readonly EntityStatusRow[],
  after: readonly EntityStatusRow[],
  fromYear: number,
  toYear: number,
): number[] {
  const years: number[] = [];
  for (let y = fromYear; y <= toYear; y++) {
    if (yearSignature(before, y) !== yearSignature(after, y)) years.push(y);
  }
  return years;
}

/**
 * The span of years worth comparing for a history edit: from the earliest
 * year any row touches (or a floor) through a couple of years past the
 * latest, so a future-dated election is included.
 */
export function comparisonYearRange(
  rows: readonly EntityStatusRow[],
  today: string,
): { fromYear: number; toYear: number } {
  // The inception sentinel is not a real year; comparing every year since
  // 1900 would only produce noise. Years before `fromYear` behave exactly
  // like `fromYear` unless a real row starts earlier.
  const years = rows
    .filter((r) => !isInceptionDate(r.effectiveFrom))
    .map((r) => Number(r.effectiveFrom.slice(0, 4)));
  const thisYear = Number(today.slice(0, 4));
  return {
    fromYear: Math.min(thisYear - 10, ...years),
    toYear: Math.max(thisYear + 2, ...years.map((y) => y + 1)),
  };
}

/* ------------------------------------------------------------------ */
/* Planned / pending elections                                         */
/* ------------------------------------------------------------------ */

export interface StatusRowFlags {
  /** Starts after `today`. */
  future: boolean;
  /** An election form is recorded but IRS acceptance is not. */
  awaitingAcceptance: boolean;
  /** Future-dated or still awaiting acceptance. */
  planned: boolean;
}

export function statusRowFlags(row: EntityStatusRow, today: string): StatusRowFlags {
  const future = row.effectiveFrom > today;
  const awaitingAcceptance = row.electionForm !== null && row.electionAcceptedOn === null;
  return { future, awaitingAcceptance, planned: future || awaitingAcceptance };
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * Statutory (unadjusted) filing deadline for an election, or null when the
 * form has no deadline we model.
 *
 * - Form 2553: no more than 2 months and 15 days after the beginning of the
 *   tax year the election is to take effect. The count includes the first
 *   day, so a calendar year beginning January 1 is due March 15.
 * - Form 8832: the effective date can be no more than 75 days before filing,
 *   so it must be filed within 75 days after the effective date.
 *
 * Weekend/holiday roll-forward (§7503) is applied by the compliance layer.
 */
export function electionStatutoryDueDate(
  electionForm: ElectionForm | null,
  effectiveFrom: string,
): string | null {
  if (electionForm === '2553') return addDays(addMonths(effectiveFrom, 2), 14);
  if (electionForm === '8832') return addDays(effectiveFrom, 75);
  return null;
}

/** Compact classification names for one-line descriptions. */
export const TAX_CLASSIFICATION_SHORT_LABELS: Record<TaxClassification, string> = {
  individual: 'Form 1040',
  disregarded: 'disregarded (Schedule C/F)',
  partnership: 'a partnership (Form 1065)',
  s_corp: 'an S-corp (Form 1120-S)',
  c_corp: 'a C-corp (Form 1120)',
  exempt: 'tax-exempt (Form 990)',
};

/** Human-readable one-line description of a status. */
export function describeStatus(row: Pick<EntityStatusRow, 'legalForm' | 'taxClassification'>): string {
  const form = LEGAL_FORM_LABELS[row.legalForm];
  if (row.legalForm === 'household') return form;
  if (row.taxClassification === 'disregarded') return `${form}, ${TAX_CLASSIFICATION_SHORT_LABELS.disregarded}`;
  return `${form} taxed as ${TAX_CLASSIFICATION_SHORT_LABELS[row.taxClassification]}`;
}

/** Compress a sorted year list for display: [2016..2026, 2028] → "2016–2026, 2028". */
export function formatYearRanges(years: readonly number[]): string {
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | null = null;
  let prev: number | null = null;
  for (const y of sorted) {
    if (start !== null && prev !== null && y === prev + 1) {
      prev = y;
      continue;
    }
    if (start !== null && prev !== null) parts.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = y;
    prev = y;
  }
  if (start !== null && prev !== null) parts.push(start === prev ? `${start}` : `${start}–${prev}`);
  return parts.join(', ');
}

/**
 * Describe the tax years a history edit affects. Comparison stops at a
 * window (see comparisonYearRange), so when the first/last compared year is
 * affected the change really runs on past the window: say so instead of
 * implying it ends there.
 */
export function describeAffectedYears(
  years: readonly number[],
  window: { fromYear: number; toYear: number },
): string {
  if (years.length === 0) return 'No tax year changes treatment.';
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  const openPast = sorted[0] === window.fromYear;
  const openFuture = sorted[sorted.length - 1] === window.toYear;
  const contiguous = sorted.length === sorted[sorted.length - 1] - sorted[0] + 1;
  if (contiguous && openPast && openFuture) return 'Every tax year changes treatment.';
  if (contiguous && openFuture) return `Tax years ${sorted[0]} onward change treatment.`;
  if (contiguous && openPast) return `Every tax year through ${sorted[sorted.length - 1]} changes treatment.`;
  return `Tax years whose treatment changes: ${formatYearRanges(sorted)}.`;
}
