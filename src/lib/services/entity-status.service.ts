/**
 * Entity status history service — persistence and resolution for the
 * effective-dated legal form / tax classification in src/lib/entity-status.ts.
 *
 * Reads never write: a book with no persisted history resolves to a single
 * synthesized row derived from its profile's entity_type (or household when
 * there is no profile), exactly what the db-init seed would have produced.
 *
 * Every mutation:
 *   - runs under a per-book advisory lock,
 *   - supports `dryRun`, returning the tax years whose treatment would change
 *     (the preview the UI shows before a correction rewrites history),
 *   - re-syncs the profile's derived entity_type to the status in effect
 *     today, and
 *   - writes an audit record.
 */

import prisma from '@/lib/prisma';
import { logAudit } from '@/lib/services/audit.service';
import {
  affectedTaxYears,
  comparisonYearRange,
  INCEPTION_DATE,
  isElectionForm,
  isIsoDate,
  isLegalForm,
  isMidYear,
  isTaxClassification,
  legacyEntityType,
  fromLegacyEntityType,
  coerceLegacyEntityType,
  resolveStatusAt,
  resolveTaxYear,
  sortHistory,
  statusPairError,
  statusRowFlags,
  type ElectionForm,
  type EntityStatusRow,
  type LegalForm,
  type StatusRowFlags,
  type TaxClassification,
  type TaxYearStatus,
} from '@/lib/entity-status';
import type { EntityType } from '@/lib/services/entity.service';

// Local copy of ENTITY_TYPES: entity.service imports this module, so a value
// import back from it would be circular.
const LEGACY_ENTITY_TYPES: readonly EntityType[] = [
  'household',
  'sole_prop',
  'llc_single',
  'llc_partnership',
  's_corp',
  'c_corp',
  'nonprofit_501c3',
];

export class EntityStatusValidationError extends Error {}
export class EntityStatusNotFoundError extends Error {}

type DbClient = Pick<typeof prisma, 'gnucash_web_entity_status_history' | 'gnucash_web_entity_profiles'>;

interface HistoryDbRow {
  id: number;
  book_guid: string;
  effective_from: Date;
  legal_form: string;
  tax_classification: string;
  election_form: string | null;
  election_filed_on: Date | null;
  election_accepted_on: Date | null;
  short_year_confirmed: boolean;
  election_document_id: number | null;
  acceptance_document_id: number | null;
  notes: string | null;
}

function isoDay(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function dateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

/** Today as a local YYYY-MM-DD (matches how the rest of the app dates "today"). */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toRow(r: HistoryDbRow): EntityStatusRow {
  return {
    id: r.id,
    effectiveFrom: isoDay(r.effective_from)!,
    legalForm: isLegalForm(r.legal_form) ? r.legal_form : 'household',
    taxClassification: isTaxClassification(r.tax_classification)
      ? r.tax_classification
      : 'individual',
    electionForm: isElectionForm(r.election_form) ? r.election_form : null,
    electionFiledOn: isoDay(r.election_filed_on),
    electionAcceptedOn: isoDay(r.election_accepted_on),
    shortYearConfirmed: r.short_year_confirmed,
    electionDocumentId: r.election_document_id,
    acceptanceDocumentId: r.acceptance_document_id,
    notes: r.notes,
  };
}

function synthesizedRow(entityType: EntityType, effectiveFrom: string): EntityStatusRow {
  const { legalForm, taxClassification } = fromLegacyEntityType(entityType);
  return {
    id: null,
    effectiveFrom,
    legalForm,
    taxClassification,
    electionForm: null,
    electionFiledOn: null,
    electionAcceptedOn: null,
    shortYearConfirmed: false,
    electionDocumentId: null,
    acceptanceDocumentId: null,
    notes: null,
  };
}

function profileEntityType(value: string | null | undefined): EntityType {
  return LEGACY_ENTITY_TYPES.includes(value as EntityType) ? (value as EntityType) : 'household';
}

export interface EntityStatusHistory {
  rows: EntityStatusRow[];
  /** True when nothing is persisted and the single row was derived. */
  synthesized: boolean;
}

async function loadHistory(db: DbClient, bookGuid: string): Promise<EntityStatusHistory> {
  const persisted = (await db.gnucash_web_entity_status_history.findMany({
    where: { book_guid: bookGuid },
    orderBy: [{ effective_from: 'asc' }, { id: 'asc' }],
  })) as HistoryDbRow[];
  if (persisted.length > 0) {
    return { rows: persisted.map(toRow), synthesized: false };
  }
  const profile = await db.gnucash_web_entity_profiles.findUnique({
    where: { book_guid: bookGuid },
    select: { entity_type: true },
  });
  return {
    rows: [synthesizedRow(profileEntityType(profile?.entity_type), INCEPTION_DATE)],
    synthesized: true,
  };
}

/** Full history for a book, oldest first. */
export async function listEntityStatusHistory(bookGuid: string): Promise<EntityStatusHistory> {
  return loadHistory(prisma, bookGuid);
}

/**
 * Histories for many books in two queries (book links, family office).
 * Books with no persisted rows get a synthesized row from their profile.
 */
export async function listEntityStatusHistories(
  bookGuids: readonly string[],
): Promise<Map<string, EntityStatusRow[]>> {
  const unique = [...new Set(bookGuids)];
  const out = new Map<string, EntityStatusRow[]>();
  if (unique.length === 0) return out;
  const [persisted, profiles] = await Promise.all([
    prisma.gnucash_web_entity_status_history.findMany({
      where: { book_guid: { in: unique } },
      orderBy: [{ effective_from: 'asc' }, { id: 'asc' }],
    }) as Promise<HistoryDbRow[]>,
    prisma.gnucash_web_entity_profiles.findMany({
      where: { book_guid: { in: unique } },
      select: { book_guid: true, entity_type: true },
    }),
  ]);
  for (const r of persisted) {
    const list = out.get(r.book_guid) ?? [];
    list.push(toRow(r));
    out.set(r.book_guid, list);
  }
  const profileOf = new Map(profiles.map((p) => [p.book_guid, p]));
  for (const guid of unique) {
    if (out.has(guid)) continue;
    const p = profileOf.get(guid);
    out.set(guid, [synthesizedRow(profileEntityType(p?.entity_type), INCEPTION_DATE)]);
  }
  return out;
}

export interface ResolvedEntityStatus {
  row: EntityStatusRow;
  entityType: EntityType;
}

function resolved(row: EntityStatusRow): ResolvedEntityStatus {
  return { row, entityType: legacyEntityType(row.legalForm, row.taxClassification) };
}

/** The status in effect on `date` (YYYY-MM-DD). */
export async function getEntityStatusAt(
  bookGuid: string,
  date: string,
): Promise<ResolvedEntityStatus> {
  const { rows } = await loadHistory(prisma, bookGuid);
  return resolved(resolveStatusAt(rows, date)!);
}

export interface ResolvedTaxYearStatus extends TaxYearStatus {
  /** Legacy type of the year-end status — what annual rule sets switch on. */
  entityType: EntityType;
}

export function taxYearFromRows(rows: readonly EntityStatusRow[], year: number): ResolvedTaxYearStatus {
  const resolvedYear = resolveTaxYear(rows, year);
  const status = resolvedYear.status!;
  return {
    ...resolvedYear,
    entityType: legacyEntityType(status.legalForm, status.taxClassification),
  };
}

/** Segments and year-end status for calendar tax year `year`. */
export async function getEntityStatusForTaxYear(
  bookGuid: string,
  year: number,
): Promise<ResolvedTaxYearStatus> {
  const { rows } = await loadHistory(prisma, bookGuid);
  return taxYearFromRows(rows, year);
}

/** Legacy entity type governing tax year `year` (year-end status). */
export async function getEntityTypeForTaxYear(bookGuid: string, year: number): Promise<EntityType> {
  return (await getEntityStatusForTaxYear(bookGuid, year)).entityType;
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

export interface StatusRowInput {
  effectiveFrom: string;
  legalForm: LegalForm;
  taxClassification: TaxClassification;
  electionForm?: ElectionForm | null;
  electionFiledOn?: string | null;
  electionAcceptedOn?: string | null;
  shortYearConfirmed?: boolean;
  electionDocumentId?: number | null;
  acceptanceDocumentId?: number | null;
  notes?: string | null;
}

export interface MutationResult {
  dryRun: boolean;
  /** Tax years whose treatment differs after the change. */
  affectedYears: number[];
  /** The window `affectedYears` was computed over (see describeAffectedYears). */
  comparedYears: { fromYear: number; toYear: number };
  /** History after the change (or as it would be, for a dry run). */
  history: EntityStatusRow[];
  /** The row created/updated (null for a delete). */
  row: EntityStatusRow | null;
  /** Legacy type in effect today after the change. */
  currentEntityType: EntityType;
}

function validateInput(input: StatusRowInput): void {
  if (!isIsoDate(input.effectiveFrom) || input.effectiveFrom < INCEPTION_DATE) {
    throw new EntityStatusValidationError('Effective date must be a valid YYYY-MM-DD date');
  }
  if (!isLegalForm(input.legalForm)) {
    throw new EntityStatusValidationError(`Invalid legal form: ${String(input.legalForm)}`);
  }
  if (!isTaxClassification(input.taxClassification)) {
    throw new EntityStatusValidationError(
      `Invalid tax classification: ${String(input.taxClassification)}`,
    );
  }
  const pairError = statusPairError(input.legalForm, input.taxClassification);
  if (pairError) throw new EntityStatusValidationError(pairError);
  if (input.electionForm != null && !isElectionForm(input.electionForm)) {
    throw new EntityStatusValidationError(`Invalid election form: ${String(input.electionForm)}`);
  }
  if (input.electionForm === '2553' && input.taxClassification !== 's_corp') {
    throw new EntityStatusValidationError('Form 2553 elects S-corporation status; set the classification to S-corporation.');
  }
  for (const [label, value] of [
    ['Election filed date', input.electionFiledOn],
    ['IRS acceptance date', input.electionAcceptedOn],
  ] as const) {
    if (value != null && !isIsoDate(value)) {
      throw new EntityStatusValidationError(`${label} must be a valid YYYY-MM-DD date`);
    }
  }
  if ((input.electionFiledOn || input.electionAcceptedOn) && !input.electionForm) {
    throw new EntityStatusValidationError('Record the election form before its filed or acceptance date.');
  }
  if (
    input.electionFiledOn &&
    input.electionAcceptedOn &&
    input.electionAcceptedOn < input.electionFiledOn
  ) {
    throw new EntityStatusValidationError('The IRS acceptance date cannot be before the filed date.');
  }
  for (const id of [input.electionDocumentId, input.acceptanceDocumentId]) {
    if (id != null && (!Number.isInteger(id) || id <= 0)) {
      throw new EntityStatusValidationError('Document ids must be positive integers');
    }
  }
}

/**
 * A mid-year effective date creates short tax years. v1 never guesses how to
 * split them: the change is refused until the caller confirms explicitly.
 */
function requireShortYearConfirmation(
  input: StatusRowInput,
  before: readonly EntityStatusRow[],
  after: readonly EntityStatusRow[],
): void {
  if (!isMidYear(input.effectiveFrom) || input.shortYearConfirmed) return;
  const year = Number(input.effectiveFrom.slice(0, 4));
  // Only when this change actually makes the year mixed.
  if (resolveTaxYear(after, year).mixed && !resolveTaxYear(before, year).mixed) {
    throw new EntityStatusValidationError(
      `An effective date of ${input.effectiveFrom} splits ${year} into short tax years. Confirm the split (and check the filings with your tax preparer) to record it.`,
    );
  }
}

async function assertDocumentsInBook(
  bookGuid: string,
  input: Pick<StatusRowInput, 'electionDocumentId' | 'acceptanceDocumentId'>,
): Promise<void> {
  const ids = [input.electionDocumentId, input.acceptanceDocumentId].filter(
    (id): id is number => typeof id === 'number',
  );
  if (ids.length === 0) return;
  const found = await prisma.gnucash_web_documents.findMany({
    where: { id: { in: ids }, book_guid: bookGuid },
    select: { id: true },
  });
  if (found.length !== new Set(ids).size) {
    throw new EntityStatusValidationError('Linked documents must belong to this book');
  }
}

function dbData(input: StatusRowInput) {
  return {
    effective_from: dateOnly(input.effectiveFrom),
    legal_form: input.legalForm,
    tax_classification: input.taxClassification,
    election_form: input.electionForm ?? null,
    election_filed_on: input.electionFiledOn ? dateOnly(input.electionFiledOn) : null,
    election_accepted_on: input.electionAcceptedOn ? dateOnly(input.electionAcceptedOn) : null,
    short_year_confirmed: input.shortYearConfirmed ?? false,
    election_document_id: input.electionDocumentId ?? null,
    acceptance_document_id: input.acceptanceDocumentId ?? null,
    notes: input.notes?.trim() || null,
  };
}

function rowFromInput(id: number | null, input: StatusRowInput): EntityStatusRow {
  return {
    id,
    effectiveFrom: input.effectiveFrom,
    legalForm: input.legalForm,
    taxClassification: input.taxClassification,
    electionForm: input.electionForm ?? null,
    electionFiledOn: input.electionFiledOn ?? null,
    electionAcceptedOn: input.electionAcceptedOn ?? null,
    shortYearConfirmed: input.shortYearConfirmed ?? false,
    electionDocumentId: input.electionDocumentId ?? null,
    acceptanceDocumentId: input.acceptanceDocumentId ?? null,
    notes: input.notes?.trim() || null,
  };
}

function rowToInput(row: EntityStatusRow): StatusRowInput {
  return {
    effectiveFrom: row.effectiveFrom,
    legalForm: row.legalForm,
    taxClassification: row.taxClassification,
    electionForm: row.electionForm,
    electionFiledOn: row.electionFiledOn,
    electionAcceptedOn: row.electionAcceptedOn,
    shortYearConfirmed: row.shortYearConfirmed,
    electionDocumentId: row.electionDocumentId,
    acceptanceDocumentId: row.acceptanceDocumentId,
    notes: row.notes,
  };
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function lockBook(tx: Tx, bookGuid: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`entity_status:${bookGuid}`}::text))::text AS locked`;
}

/**
 * Persist the synthesized row so later edits have something to edit. Called
 * inside the locked transaction before any mutation of a book that has no
 * history yet.
 */
async function materialize(tx: Tx, bookGuid: string, userId: number | null): Promise<EntityStatusRow[]> {
  const history = await loadHistory(tx as unknown as DbClient, bookGuid);
  if (!history.synthesized) return history.rows;
  const seed = history.rows[0];
  const created = (await tx.gnucash_web_entity_status_history.create({
    data: {
      book_guid: bookGuid,
      ...dbData({ ...rowToInput(seed), notes: 'Seeded from the entity profile' }),
      created_by: userId,
      updated_by: userId,
    },
  })) as HistoryDbRow;
  return [toRow(created)];
}

/**
 * Keep the profile's derived entity_type equal to the status in effect
 * today. Creates no profile: a book without one keeps the synthesized
 * household profile.
 */
async function syncProfileEntityType(
  tx: Pick<Tx, 'gnucash_web_entity_profiles'>,
  bookGuid: string,
  rows: readonly EntityStatusRow[],
  today: string,
): Promise<EntityType> {
  const current = resolveStatusAt(rows, today)!;
  const entityType = legacyEntityType(current.legalForm, current.taxClassification);
  await tx.gnucash_web_entity_profiles.updateMany({
    where: { book_guid: bookGuid, NOT: { entity_type: entityType } },
    data: { entity_type: entityType, updated_at: new Date() },
  });
  return entityType;
}

interface MutationOptions {
  dryRun?: boolean;
  userId?: number | null;
  today?: string;
}

interface AuditRecord {
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  id: number;
  old: object | null;
  new: object | null;
}

interface AppliedChange {
  after: EntityStatusRow[];
  row: EntityStatusRow | null;
  /** Null when the change turned out to be a no-op. */
  audit: AuditRecord | null;
}

/** Thrown inside a dry run's transaction so nothing it wrote is committed. */
class DryRunRollback extends Error {}

async function runMutation(
  bookGuid: string,
  opts: MutationOptions,
  apply: (tx: Tx, before: EntityStatusRow[]) => Promise<AppliedChange>,
): Promise<MutationResult> {
  const today = opts.today ?? todayIso();
  const userId = opts.userId ?? null;
  const dryRun = opts.dryRun === true;

  // A dry run must see exactly what a real run would (including the seed a
  // first edit materializes), so it runs the same code in a transaction that
  // is always rolled back.
  let result: MutationResult | null = null;
  let audit: AuditRecord | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      await lockBook(tx, bookGuid);
      const before = await materialize(tx, bookGuid, userId);
      const applied = await apply(tx, before);
      const { fromYear, toYear } = comparisonYearRange([...before, ...applied.after], today);
      const currentEntityType = await syncProfileEntityType(tx, bookGuid, applied.after, today);
      result = {
        dryRun,
        affectedYears: affectedTaxYears(before, applied.after, fromYear, toYear),
        comparedYears: { fromYear, toYear },
        history: sortHistory(applied.after),
        row: applied.row,
        currentEntityType,
      };
      audit = applied.audit;
      if (dryRun) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  const final = result as MutationResult | null;
  if (!final) throw new Error('Entity status mutation produced no result');
  const record = audit as AuditRecord | null;
  if (!dryRun && record) {
    await logAudit(
      record.action,
      'ENTITY_STATUS',
      String(record.id),
      record.old,
      { ...(record.new ?? {}), affectedYears: final.affectedYears },
      { bookGuid, userId },
    );
  }
  return final;
}

function assertUniqueDate(rows: readonly EntityStatusRow[], effectiveFrom: string, exceptId: number | null): void {
  if (rows.some((r) => r.effectiveFrom === effectiveFrom && r.id !== exceptId)) {
    throw new EntityStatusValidationError(
      `A status change is already recorded effective ${effectiveFrom}; correct that row instead.`,
    );
  }
}

/** Record a change in status effective on a date (a new history row). */
export async function recordEntityStatusChange(
  bookGuid: string,
  input: StatusRowInput,
  opts: MutationOptions = {},
): Promise<MutationResult> {
  validateInput(input);
  await assertDocumentsInBook(bookGuid, input);
  return runMutation(bookGuid, opts, async (tx, before) => {
    assertUniqueDate(before, input.effectiveFrom, null);
    const candidate = rowFromInput(-1, input);
    requireShortYearConfirmation(input, before, [...before, candidate]);
    const created = (await tx.gnucash_web_entity_status_history.create({
      data: {
        book_guid: bookGuid,
        ...dbData(input),
        created_by: opts.userId ?? null,
        updated_by: opts.userId ?? null,
      },
    })) as HistoryDbRow;
    const row = toRow(created);
    return {
      after: [...before, row],
      row,
      audit: { action: 'CREATE', id: row.id!, old: null, new: row },
    };
  });
}

/**
 * Correct an existing row in place — rewrites history for every tax year the
 * row covers. Callers should dry-run first and show `affectedYears`.
 */
export async function correctEntityStatusRow(
  bookGuid: string,
  id: number,
  input: StatusRowInput,
  opts: MutationOptions = {},
): Promise<MutationResult> {
  validateInput(input);
  await assertDocumentsInBook(bookGuid, input);
  return runMutation(bookGuid, opts, async (tx, before) => {
    const existing = before.find((r) => r.id === id);
    if (!existing) throw new EntityStatusNotFoundError(`Status row ${id} not found`);
    assertUniqueDate(before, input.effectiveFrom, id);
    const updatedRow = rowFromInput(id, input);
    const after = before.map((r) => (r.id === id ? updatedRow : r));
    requireShortYearConfirmation(input, before, after);
    await tx.gnucash_web_entity_status_history.update({
      where: { id },
      data: { ...dbData(input), updated_by: opts.userId ?? null, updated_at: new Date() },
    });
    return {
      after,
      row: updatedRow,
      audit: { action: 'UPDATE', id, old: existing, new: updatedRow },
    };
  });
}

/** Remove a row. The last remaining row cannot be deleted. */
export async function deleteEntityStatusRow(
  bookGuid: string,
  id: number,
  opts: MutationOptions = {},
): Promise<MutationResult> {
  return runMutation(bookGuid, opts, async (tx, before) => {
    const existing = before.find((r) => r.id === id);
    if (!existing) throw new EntityStatusNotFoundError(`Status row ${id} not found`);
    if (before.length === 1) {
      throw new EntityStatusValidationError(
        'A book needs at least one status. Correct this row instead of deleting it.',
      );
    }
    await tx.gnucash_web_entity_status_history.delete({ where: { id } });
    return {
      after: before.filter((r) => r.id !== id),
      row: null,
      audit: { action: 'DELETE', id, old: existing, new: null },
    };
  });
}

/**
 * Bridge for the legacy single-field profile editor and the book-creation /
 * import paths that still write `entityType`: when the requested type
 * differs from the status in effect today, correct THAT row (keeping a
 * compatible legal form). Future-dated rows are left alone. No-op when the
 * type already matches.
 */
export async function applyLegacyEntityType(
  bookGuid: string,
  entityType: EntityType,
  opts: MutationOptions = {},
): Promise<MutationResult | null> {
  const today = opts.today ?? todayIso();
  const matches = (row: EntityStatusRow) =>
    legacyEntityType(row.legalForm, row.taxClassification) === entityType;

  // Cheap unlocked check first so a no-op save never materializes a seed.
  const { rows } = await loadHistory(prisma, bookGuid);
  if (matches(resolveStatusAt(rows, today)!)) return null;

  return runMutation(bookGuid, opts, async (tx, before) => {
    const current = resolveStatusAt(before, today)!;
    if (matches(current)) return { after: before, row: current, audit: null };
    const next = coerceLegacyEntityType(current, entityType);
    const classificationChanged = next.taxClassification !== current.taxClassification;
    const updatedRow: EntityStatusRow = {
      ...current,
      ...next,
      // An election belongs to the classification it elected.
      ...(classificationChanged
        ? { electionForm: null, electionFiledOn: null, electionAcceptedOn: null }
        : {}),
    };
    await tx.gnucash_web_entity_status_history.update({
      where: { id: current.id! },
      data: {
        ...dbData(rowToInput(updatedRow)),
        updated_by: opts.userId ?? null,
        updated_at: new Date(),
      },
    });
    return {
      after: before.map((r) => (r.id === current.id ? updatedRow : r)),
      row: updatedRow,
      audit: { action: 'UPDATE', id: current.id!, old: current, new: updatedRow },
    };
  });
}

/**
 * Re-derive every profile's `entity_type` from its history as of `today`.
 * Mutations already sync the book they touch; this catches the day a
 * future-dated change (a planned S election) simply arrives, for the few
 * readers that still read the column directly. Returns the books updated.
 */
export async function syncAllProfileEntityTypes(today: string = todayIso()): Promise<string[]> {
  const persisted = (await prisma.gnucash_web_entity_status_history.findMany({
    orderBy: [{ book_guid: 'asc' }, { effective_from: 'asc' }, { id: 'asc' }],
  })) as HistoryDbRow[];
  const byBook = new Map<string, EntityStatusRow[]>();
  for (const r of persisted) {
    const list = byBook.get(r.book_guid) ?? [];
    list.push(toRow(r));
    byBook.set(r.book_guid, list);
  }
  const updated: string[] = [];
  for (const [bookGuid, rows] of byBook) {
    const current = resolveStatusAt(rows, today)!;
    const entityType = legacyEntityType(current.legalForm, current.taxClassification);
    const { count } = await prisma.gnucash_web_entity_profiles.updateMany({
      where: { book_guid: bookGuid, NOT: { entity_type: entityType } },
      data: { entity_type: entityType, updated_at: new Date() },
    });
    if (count > 0) updated.push(bookGuid);
  }
  return updated;
}

/* ------------------------------------------------------------------ */
/* View model                                                          */
/* ------------------------------------------------------------------ */

export interface EntityStatusRowView extends EntityStatusRow, StatusRowFlags {
  /** Legacy entity type this row maps to. */
  entityType: EntityType;
  /** Last day this row is in effect (null = open-ended). */
  effectiveTo: string | null;
  /** The earliest row also applies to every earlier date. */
  sinceInception: boolean;
}

export function toRowViews(rows: readonly EntityStatusRow[], today: string): EntityStatusRowView[] {
  const sorted = sortHistory(rows);
  return sorted.map((row, i) => {
    const next = sorted[i + 1];
    let effectiveTo: string | null = null;
    if (next) {
      const [y, m, d] = next.effectiveFrom.split('-').map(Number);
      effectiveTo = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
    }
    return {
      ...row,
      ...statusRowFlags(row, today),
      entityType: legacyEntityType(row.legalForm, row.taxClassification),
      effectiveTo,
      sinceInception: i === 0,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Request parsing (shared by the API routes)                          */
/* ------------------------------------------------------------------ */

function optionalDate(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalId(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Parse an untrusted JSON body into a StatusRowInput. Shape errors become
 * EntityStatusValidationError; semantic validation happens in the mutation.
 */
export function parseStatusRowInput(body: unknown): StatusRowInput {
  if (!body || typeof body !== 'object') {
    throw new EntityStatusValidationError('Request body must be a JSON object');
  }
  const b = body as Record<string, unknown>;
  return {
    effectiveFrom: typeof b.effectiveFrom === 'string' ? b.effectiveFrom.trim() : '',
    legalForm: b.legalForm as LegalForm,
    taxClassification: b.taxClassification as TaxClassification,
    electionForm:
      b.electionForm === null || b.electionForm === undefined || b.electionForm === ''
        ? null
        : (b.electionForm as ElectionForm),
    electionFiledOn: optionalDate(b.electionFiledOn),
    electionAcceptedOn: optionalDate(b.electionAcceptedOn),
    shortYearConfirmed: b.shortYearConfirmed === true,
    electionDocumentId: optionalId(b.electionDocumentId),
    acceptanceDocumentId: optionalId(b.acceptanceDocumentId),
    notes: typeof b.notes === 'string' ? b.notes : null,
  };
}
