/**
 * Saved Reports Service Layer
 *
 * Wraps Prisma calls for saved report CRUD operations.
 * All functions take userId as a parameter (auth is handled by API layer).
 *
 * Reports are scoped per-user AND per-book: list/create take the active
 * book's guid, and single-row operations verify the row belongs to the
 * expected book (mismatch behaves as "not found" so nothing leaks).
 */

import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { SavedReport, SavedReportInput, ReportType, ReportFilters } from './types';

/**
 * Valid report types for validation
 */
const VALID_REPORT_TYPES = new Set<string>([
  'balance_sheet',
  'income_statement',
  'cash_flow',
  'account_summary',
  'transaction_report',
  'treasurer',
  'equity_statement',
  'trial_balance',
  'general_journal',
  'general_ledger',
  'investment_portfolio',
  'reconciliation',
  'net_worth_chart',
  'income_expense_chart',
]);

const GUID_RE = /[0-9a-f]{32}/gi;

/**
 * Extract candidate account guids from a saved report's config.
 *
 * Mirrors (in TypeScript) what the db-init backfill does in SQL: the explicit
 * `accountGuids` array is preferred, then any 32-hex substring anywhere in
 * the serialized config is included as a fallback. Returns lowercase guids,
 * deduplicated, with the explicit accountGuids entries first.
 */
export function extractAccountGuidsFromConfig(config: unknown): string[] {
  if (config === null || typeof config !== 'object') return [];

  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (guid: string) => {
    const lower = guid.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      ordered.push(lower);
    }
  };

  // Pass 1: explicit accountGuids array
  const accountGuids = (config as Record<string, unknown>).accountGuids;
  if (Array.isArray(accountGuids)) {
    for (const entry of accountGuids) {
      if (typeof entry === 'string' && /^[0-9a-f]{32}$/i.test(entry)) {
        push(entry);
      }
    }
  }

  // Pass 2 (fallback): any 32-hex substring anywhere in the config
  let serialized = '';
  try {
    serialized = JSON.stringify(config) ?? '';
  } catch {
    return ordered; // circular config — explicit guids only
  }
  for (const match of serialized.match(GUID_RE) ?? []) {
    push(match);
  }

  return ordered;
}

/**
 * Helper to convert DB row to SavedReport interface (snake_case -> camelCase)
 */
type SavedReportRow = Prisma.gnucash_web_saved_reportsGetPayload<Record<string, never>>;

function toSavedReport(row: SavedReportRow): SavedReport {
  if (row.user_id == null) {
    throw new Error(`Saved report ${row.id} is missing a user_id`);
  }

  return {
    id: row.id,
    userId: row.user_id,
    bookGuid: row.book_guid,
    baseReportType: row.base_report_type as ReportType,
    name: row.name,
    description: row.description,
    config: (row.config as Record<string, unknown>) || {},
    filters: row.filters ? (row.filters as unknown as ReportFilters) : null,
    isStarred: row.is_starred,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Validates that config is a non-null plain object
 */
function validateConfig(config: unknown): void {
  if (config === null || config === undefined) {
    throw new Error('config must be a non-null object');
  }
  if (typeof config !== 'object') {
    throw new Error('config must be an object, not a primitive or string');
  }
  if (Array.isArray(config)) {
    throw new Error('config must be a plain object, not an array');
  }
}

/**
 * Ownership + book gate for single-row operations. A row from another user
 * or another book is treated exactly like a missing row. Passing `undefined`
 * for bookGuid skips the book check (server-side jobs that resolve their
 * book scope elsewhere, e.g. the report scheduler).
 */
function isAccessible(
  row: SavedReportRow | null,
  userId: number,
  bookGuid: string | undefined
): row is SavedReportRow {
  if (!row || row.user_id !== userId) return false;
  if (bookGuid !== undefined && row.book_guid !== bookGuid) return false;
  return true;
}

/**
 * List all saved reports for a user in a book, starred first, then by updated_at desc
 */
export async function listSavedReports(userId: number, bookGuid: string): Promise<SavedReport[]> {
  const rows = await prisma.gnucash_web_saved_reports.findMany({
    where: { user_id: userId, book_guid: bookGuid },
    orderBy: [
      { is_starred: 'desc' },
      { updated_at: 'desc' },
    ],
  });

  return rows.map(toSavedReport);
}

/**
 * Get a single saved report by ID (validates ownership, and book when given)
 */
export async function getSavedReport(
  id: number,
  userId: number,
  bookGuid?: string
): Promise<SavedReport | null> {
  const row = await prisma.gnucash_web_saved_reports.findUnique({
    where: { id },
  });

  return isAccessible(row, userId, bookGuid) ? toSavedReport(row) : null;
}

/**
 * Create a new saved report in the given book
 */
export async function createSavedReport(
  userId: number,
  bookGuid: string,
  input: SavedReportInput
): Promise<SavedReport> {
  // Validate report type
  if (!VALID_REPORT_TYPES.has(input.baseReportType)) {
    throw new Error(`Invalid base_report_type: ${input.baseReportType}`);
  }

  // Validate config is a plain object
  validateConfig(input.config);

  const row = await prisma.gnucash_web_saved_reports.create({
    data: {
      user_id: userId,
      book_guid: bookGuid,
      base_report_type: input.baseReportType,
      name: input.name,
      description: input.description || null,
      config: input.config as Prisma.InputJsonValue,
      filters: input.filters ? (input.filters as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      is_starred: input.isStarred ?? false,
    },
  });

  return toSavedReport(row);
}

/**
 * Update an existing saved report (validates ownership + book)
 */
export async function updateSavedReport(
  id: number,
  userId: number,
  bookGuid: string,
  input: Partial<SavedReportInput>
): Promise<SavedReport | null> {
  // Validate report type if provided
  if (input.baseReportType && !VALID_REPORT_TYPES.has(input.baseReportType)) {
    throw new Error(`Invalid base_report_type: ${input.baseReportType}`);
  }

  // Validate config if provided
  if (input.config !== undefined) {
    validateConfig(input.config);
  }

  // Check ownership + book first
  const existing = await prisma.gnucash_web_saved_reports.findUnique({
    where: { id },
  });

  if (!isAccessible(existing, userId, bookGuid)) {
    return null; // Not found, not owned by this user, or in another book
  }

  // Build update data
  const updateData: Prisma.gnucash_web_saved_reportsUpdateInput = {
    updated_at: new Date(), // Explicit update timestamp
  };

  if (input.baseReportType !== undefined) {
    updateData.base_report_type = input.baseReportType;
  }
  if (input.name !== undefined) {
    updateData.name = input.name;
  }
  if (input.description !== undefined) {
    updateData.description = input.description || null;
  }
  if (input.config !== undefined) {
    updateData.config = input.config as Prisma.InputJsonValue;
  }
  if (input.filters !== undefined) {
    updateData.filters = input.filters ? (input.filters as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
  }
  if (input.isStarred !== undefined) {
    updateData.is_starred = input.isStarred;
  }

  const row = await prisma.gnucash_web_saved_reports.update({
    where: { id },
    data: updateData,
  });

  return toSavedReport(row);
}

/**
 * Delete a saved report (validates ownership + book)
 */
export async function deleteSavedReport(id: number, userId: number, bookGuid: string): Promise<boolean> {
  // Check ownership + book first
  const existing = await prisma.gnucash_web_saved_reports.findUnique({
    where: { id },
  });

  if (!isAccessible(existing, userId, bookGuid)) {
    return false; // Not found, not owned by this user, or in another book
  }

  await prisma.gnucash_web_saved_reports.delete({
    where: { id },
  });

  return true;
}

/**
 * Toggle star status (validates ownership + book)
 */
export async function toggleStar(
  id: number,
  userId: number,
  bookGuid: string
): Promise<{ isStarred: boolean } | null> {
  // Check ownership + book, and get current state
  const existing = await prisma.gnucash_web_saved_reports.findUnique({
    where: { id },
  });

  if (!isAccessible(existing, userId, bookGuid)) {
    return null; // Not found, not owned by this user, or in another book
  }

  const newStarredState = !existing.is_starred;

  await prisma.gnucash_web_saved_reports.update({
    where: { id },
    data: {
      is_starred: newStarredState,
      updated_at: new Date(), // Explicit update timestamp
    },
  });

  return { isStarred: newStarredState };
}

/**
 * Get starred reports for a user in a book (for the reports index page)
 */
export async function getStarredReports(userId: number, bookGuid: string): Promise<SavedReport[]> {
  const rows = await prisma.gnucash_web_saved_reports.findMany({
    where: {
      user_id: userId,
      book_guid: bookGuid,
      is_starred: true,
    },
    orderBy: { updated_at: 'desc' },
  });

  return rows.map(toSavedReport);
}
