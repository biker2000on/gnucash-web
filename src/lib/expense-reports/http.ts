/**
 * Shared plumbing for the /api/expense-reports routes: role check, the
 * cross-book context, error mapping, and small body parsers.
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { ExpenseReportError, type ExpenseReportContext } from './shared';

export async function routeContext(
  minimumRole: 'readonly' | 'edit',
): Promise<ExpenseReportContext | NextResponse> {
  const role = await requireRole(minimumRole);
  if (role instanceof NextResponse) return role;
  return { user: { id: role.user.id }, role: role.role, bookGuid: role.bookGuid, viaToken: role.viaToken };
}

export function errorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof ExpenseReportError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(`${fallback}:`, error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ExpenseReportError('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function requiredStr(value: unknown, label: string): string {
  const s = str(value);
  if (!s) throw new ExpenseReportError(`${label} is required.`);
  return s;
}

export function optionalGuid(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/i.test(value)) {
    throw new ExpenseReportError('Invalid account or record id.');
  }
  return value;
}

export function cents(value: unknown, label = 'amount'): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(n)) throw new ExpenseReportError(`The ${label} must be a whole number of cents.`);
  return n;
}

export function isoDate(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ExpenseReportError(`${label} must be YYYY-MM-DD.`);
  }
  return value;
}

export function reportId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ExpenseReportError('Invalid report id.', 404);
  return id;
}
