/**
 * Owner expense reports — read models for the UI: the active book's links,
 * settings and reports, account lists for cross-book pickers, and account
 * names for display.
 */

import prisma from '@/lib/prisma';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { buildAccountPathMap } from '@/lib/reports/utils';
import { getLinksForBusinessBook, getLinksToHouseholdBook } from '@/lib/services/book-links.service';
import { getEntityStatusAt, listEntityStatusHistory, todayIso } from '@/lib/services/entity-status.service';
import { statusRowFlags, describeStatus } from '@/lib/entity-status';
import { describeCategorizedBy } from './model';
import {
  ExpenseReportError,
  getSettings,
  mapReport,
  requireBookRead,
  type ExpenseReportContext,
  type ExpenseReportSettings,
  type ReportRecord,
} from './shared';

export interface LinkOverview {
  side: 'household' | 'business';
  businessBookGuid: string;
  householdBookGuid: string;
  businessName: string;
  householdName: string;
  settings: ExpenseReportSettings;
  /** The business's status today and its next planned change (accountable-plan context). */
  businessStatus: string;
  nextStatusChange: { effectiveFrom: string; description: string } | null;
  /** The caller can edit the other side of the link too. */
  canEditOtherSide: boolean;
}

export interface ReportView extends ReportRecord {
  side: 'household' | 'business';
  businessName: string;
  householdName: string;
  lines: Array<ReportRecord['lines'][number] & { categorizedByLabel: string; expenseAccountName: string | null }>;
}

export interface Overview {
  bookGuid: string;
  links: LinkOverview[];
  reports: ReportView[];
}

async function statusContext(businessBookGuid: string): Promise<Pick<LinkOverview, 'businessStatus' | 'nextStatusChange'>> {
  const today = todayIso();
  const [current, history] = await Promise.all([
    getEntityStatusAt(businessBookGuid, today),
    listEntityStatusHistory(businessBookGuid),
  ]);
  const next = history.rows.find((r) => statusRowFlags(r, today).future) ?? null;
  return {
    businessStatus: describeStatus(current.row),
    nextStatusChange: next ? { effectiveFrom: next.effectiveFrom, description: describeStatus(next) } : null,
  };
}

export async function getOverview(ctx: ExpenseReportContext, bookGuid: string): Promise<Overview> {
  const { hasTargetBookRole } = await import('@/lib/target-book-auth');
  const [asHousehold, asBusiness] = await Promise.all([
    getLinksToHouseholdBook(bookGuid),
    getLinksForBusinessBook(bookGuid),
  ]);
  const links: LinkOverview[] = [];
  for (const link of asHousehold) {
    links.push({
      side: 'household',
      businessBookGuid: link.businessBookGuid,
      householdBookGuid: link.householdBookGuid,
      businessName: link.businessEntityName ?? link.businessBookName ?? 'Business',
      householdName: link.householdBookName ?? 'Household',
      settings: await getSettings(link.businessBookGuid, link.householdBookGuid),
      canEditOtherSide: await hasTargetBookRole(ctx, link.businessBookGuid, 'edit'),
      ...(await statusContext(link.businessBookGuid)),
    });
  }
  for (const link of asBusiness) {
    links.push({
      side: 'business',
      businessBookGuid: link.businessBookGuid,
      householdBookGuid: link.householdBookGuid,
      businessName: link.businessEntityName ?? link.businessBookName ?? 'Business',
      householdName: link.householdBookName ?? 'Household',
      settings: await getSettings(link.businessBookGuid, link.householdBookGuid),
      canEditOtherSide: await hasTargetBookRole(ctx, link.householdBookGuid, 'edit'),
      ...(await statusContext(link.businessBookGuid)),
    });
  }

  const rows = await prisma.gnucash_web_expense_reports.findMany({
    where: { OR: [{ business_book_guid: bookGuid }, { household_book_guid: bookGuid }] },
    include: { lines: true },
    orderBy: [{ submitted_at: 'desc' }],
    take: 200,
  });
  const names = new Map<string, string>();
  for (const l of links) {
    names.set(l.businessBookGuid, l.businessName);
    names.set(l.householdBookGuid, l.householdName);
  }
  const reports = await decorate(rows.map((r) => mapReport(r as Parameters<typeof mapReport>[0])), bookGuid, names);
  return { bookGuid, links, reports };
}

async function decorate(reports: ReportRecord[], bookGuid: string, names: Map<string, string>): Promise<ReportView[]> {
  const accountGuids = [...new Set(reports.flatMap((r) => r.lines.map((l) => l.expenseAccountGuid)).filter((g): g is string => !!g))];
  const paths = accountGuids.length > 0 ? await buildAccountPathMap(accountGuids) : new Map<string, string>();
  return reports.map((r) => ({
    ...r,
    side: r.businessBookGuid === bookGuid ? 'business' : 'household',
    businessName: names.get(r.businessBookGuid) ?? 'Business',
    householdName: names.get(r.householdBookGuid) ?? 'Household',
    lines: r.lines.map((l) => ({
      ...l,
      categorizedByLabel: describeCategorizedBy(l.categorizedBy),
      expenseAccountName: l.expenseAccountGuid ? paths.get(l.expenseAccountGuid) ?? null : null,
    })),
  }));
}

export async function getReportView(ctx: ExpenseReportContext, bookGuid: string, reportId: number): Promise<ReportView> {
  const overview = await getOverview(ctx, bookGuid);
  const report = overview.reports.find((r) => r.id === reportId);
  if (!report) throw new ExpenseReportError('Expense report not found.', 404);
  return report;
}

/**
 * Accounts of `bookGuid` for a picker, as full paths. The caller must be able
 * to read that book (it may not be the active one).
 */
export async function listBookAccounts(
  ctx: ExpenseReportContext,
  bookGuid: string,
  types: readonly string[],
): Promise<Array<{ guid: string; path: string; type: string }>> {
  await requireBookRead(ctx, bookGuid, 'requested');
  const guids = await getAccountGuidsForBook(bookGuid);
  const accounts = await prisma.accounts.findMany({
    where: { guid: { in: guids }, account_type: { in: [...types] }, placeholder: 0, hidden: 0 },
    select: { guid: true, account_type: true },
  });
  const paths = await buildAccountPathMap(guids);
  return accounts
    .map((a) => ({ guid: a.guid, path: paths.get(a.guid) ?? a.guid, type: a.account_type }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Employees of the business book (for the owner-employee setting). */
export async function listBusinessEmployees(
  ctx: ExpenseReportContext,
  businessBookGuid: string,
): Promise<Array<{ guid: string; name: string }>> {
  await requireBookRead(ctx, businessBookGuid, 'business');
  const { listEmployees } = await import('@/lib/business/employees.service');
  const employees = await listEmployees(businessBookGuid, { active: 'active' });
  return employees.map((e) => ({ guid: e.guid, name: e.name || e.username }));
}

/**
 * Create the owner's employee record in the business book, enable the
 * Employees & Vouchers module there, and save it as the link's employee.
 */
export async function setupOwnerEmployee(
  ctx: ExpenseReportContext,
  businessBookGuid: string,
  householdBookGuid: string,
  name: string,
): Promise<ExpenseReportSettings> {
  const { requireBookEdit, saveSettings, assertBookLink } = await import('./shared');
  await assertBookLink(businessBookGuid, householdBookGuid);
  await requireBookEdit(ctx, businessBookGuid, 'business');
  const trimmed = name.trim();
  if (!trimmed) throw new ExpenseReportError('Enter the owner’s name.');
  const currency = await prisma.$queryRaw<Array<{ mnemonic: string }>>`
    SELECT c.mnemonic FROM books b
      JOIN accounts a ON a.parent_guid = b.root_account_guid
      JOIN commodities c ON c.guid = a.commodity_guid AND c.namespace = 'CURRENCY'
     WHERE b.guid = ${businessBookGuid}
     GROUP BY c.mnemonic ORDER BY COUNT(*) DESC LIMIT 1
  `;
  const { createEmployee } = await import('@/lib/business/employees.service');
  const username = `owner-${trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'owner'}`;
  const employee = await createEmployee(businessBookGuid, {
    username,
    language: '',
    active: true,
    currency: currency[0]?.mnemonic ?? 'USD',
    workday: 8,
    rate: 0,
    address: { name: trimmed },
  });
  const { setBookFeatureOverride } = await import('@/lib/services/book-features.service');
  await setBookFeatureOverride(businessBookGuid, 'employees', true);
  return saveSettings(ctx, businessBookGuid, householdBookGuid, { employeeGuid: employee.guid });
}
