/**
 * Saved Reports Service Layer
 *
 * Wraps Prisma calls for saved report CRUD operations.
 * All functions take userId as a parameter (auth is handled by API layer).
 */

import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { SavedReport, SavedReportInput, ReportType } from './types';

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
]);

/**
 * Helper to convert DB row to SavedReport interface (snake_case -> camelCase)
 */
function toSavedReport(row: any): SavedReport {
  return {
    id: row.id,
    userId: row.user_id,
    baseReportType: row.base_report_type as ReportType,
    name: row.name,
    description: row.description,
    config: (row.config as Record<string, unknown>) || {},
    filters: row.filters ? (row.filters as any) : null,
    isStarred: row.is_starred,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Validates that config is a non-null plain object
 */
function validateConfig(config: any): void {
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
 * List all saved reports for a user, starred first, then by updated_at desc
 */
export async function listSavedReports(userId: number): Promise<SavedReport[]> {
  const rows = await prisma.gnucash_web_saved_reports.findMany({
    where: { user_id: userId },
    orderBy: [
      { is_starred: 'desc' },
      { updated_at: 'desc' },
    ],
  });

  return rows.map(toSavedReport);
}

/**
 * Get a single saved report by ID (validates ownership)
 */
export async function getSavedReport(id: number, userId: number): Promise<SavedReport | null> {
  const row = await prisma.gnucash_web_saved_reports.findUnique({
    where: {
      id,
      user_id: userId, // Ownership check
    },
  });

  return row ? toSavedReport(row) : null;
}

/**
 * Create a new saved report
 */
export async function createSavedReport(userId: number, input: SavedReportInput): Promise<SavedReport> {
  // Validate report type
  if (!VALID_REPORT_TYPES.has(input.baseReportType)) {
    throw new Error(`Invalid base_report_type: ${input.baseReportType}`);
  }

  // Validate config is a plain object
  validateConfig(input.config);

  const row = await prisma.gnucash_web_saved_reports.create({
    data: {
      user_id: userId,
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
 * Update an existing saved report (validates ownership)
 */
export async function updateSavedReport(
  id: number,
  userId: number,
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

  // Check ownership first
  const existing = await prisma.gnucash_web_saved_reports.findUnique({
    where: { id },
  });

  if (!existing || existing.user_id !== userId) {
    return null; // Not found or not owned by this user
  }

  // Build update data
  const updateData: any = {
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
 * Delete a saved report (validates ownership)
 */
export async function deleteSavedReport(id: number, userId: number): Promise<boolean> {
  // Check ownership first
  const existing = await prisma.gnucash_web_saved_reports.findUnique({
    where: { id },
  });

  if (!existing || existing.user_id !== userId) {
    return false; // Not found or not owned by this user
  }

  await prisma.gnucash_web_saved_reports.delete({
    where: { id },
  });

  return true;
}

/**
 * Toggle star status
 */
export async function toggleStar(
  id: number,
  userId: number
): Promise<{ isStarred: boolean } | null> {
  // Check ownership and get current state
  const existing = await prisma.gnucash_web_saved_reports.findUnique({
    where: { id },
  });

  if (!existing || existing.user_id !== userId) {
    return null; // Not found or not owned by this user
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
 * Get starred reports for a user (for the reports index page)
 */
export async function getStarredReports(userId: number): Promise<SavedReport[]> {
  const rows = await prisma.gnucash_web_saved_reports.findMany({
    where: {
      user_id: userId,
      is_starred: true,
    },
    orderBy: { updated_at: 'desc' },
  });

  return rows.map(toSavedReport);
}
