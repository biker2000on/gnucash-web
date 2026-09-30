/**
 * Client-side types and fetch helpers for /api/expense-reports.
 * Types mirror the server read models (src/lib/expense-reports/overview.ts);
 * they are redeclared here so client code never imports server modules.
 */

import { readErrorBody } from '@/lib/api-error';
import type { ReportStatus, SettlementMode } from '@/lib/expense-reports/model';

export interface Settings {
  businessBookGuid: string;
  householdBookGuid: string;
  reimbursableAccountGuid: string | null;
  employeeGuid: string | null;
  settlementMode: SettlementMode;
  contributionAccountGuid: string | null;
  householdInvestmentAccountGuid: string | null;
  householdDepositAccountGuid: string | null;
  paymentAccountGuid: string | null;
  submissionDeadlineDays: number;
  reportSince: string | null;
  saved: boolean;
}

export interface LinkOverview {
  side: 'household' | 'business';
  businessBookGuid: string;
  householdBookGuid: string;
  businessName: string;
  householdName: string;
  settings: Settings;
  businessStatus: string;
  nextStatusChange: { effectiveFrom: string; description: string } | null;
  canEditOtherSide: boolean;
}

export interface ReportLineView {
  id: number;
  kind: 'business' | 'personal';
  sourceSplitGuid: string;
  sourceTxGuid: string;
  amountCents: number;
  expenseDate: string;
  description: string;
  businessPurpose: string | null;
  expenseAccountGuid: string | null;
  categorizedBy: string | null;
  categorizedByLabel: string;
  expenseAccountName: string | null;
  documentIds: number[];
  accountablePlan: boolean;
  late: boolean;
  sortOrder: number;
}

export interface ReportView {
  id: number;
  number: number;
  label: string;
  side: 'household' | 'business';
  businessBookGuid: string;
  householdBookGuid: string;
  businessName: string;
  householdName: string;
  status: ReportStatus;
  settlementMode: SettlementMode;
  title: string | null;
  notes: string | null;
  submittedAt: string;
  approvedAt: string | null;
  voucherGuid: string | null;
  paymentTxnGuid: string | null;
  paidAt: string | null;
  householdTxnGuid: string | null;
  householdSettledAt: string | null;
  rejectionReason: string | null;
  totalCents: number;
  lines: ReportLineView[];
}

export interface Overview {
  bookGuid: string;
  links: LinkOverview[];
  reports: ReportView[];
}

export interface Candidate {
  splitGuid: string;
  txGuid: string;
  date: string;
  description: string;
  memo: string;
  paidFrom: string | null;
  valueCents: number;
  remainderCents: number;
  documentCount: number;
  badge: string | null;
  reconciled: boolean;
}

export interface AccountOption {
  guid: string;
  path: string;
  type: string;
}

export interface RewritePreview {
  txGuid: string;
  date: string;
  description: string;
  before: Array<{ accountGuid: string; cents: number }>;
  after: Array<{ accountGuid: string; cents: number }>;
}

export interface ApprovalPreview {
  mode: SettlementMode;
  totalCents: number;
  byAccount: Array<{ accountGuid: string; cents: number; lines: number }>;
  blockers: string[];
  creditAccountGuid: string | null;
  postDate: string;
}

export interface SubmitLinePreview {
  splitGuid: string;
  date: string;
  description: string;
  amountCents: number;
  taxClassification: string;
  accountablePlan: boolean;
  missing: string[];
  late: boolean;
  suggestion: { accountGuid: string; categorizedBy: string } | null;
  documentIds: number[];
}

export interface DepositMatch {
  txGuid: string;
  date: string;
  description: string;
  counterSplitGuid: string;
  counterAccountName: string;
}

export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    ...(json !== undefined
      ? { method: rest.method ?? 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) }
      : {}),
  });
  if (!res.ok) throw new Error(await readErrorBody(res, 'Request failed'));
  return (await res.json()) as T;
}

export async function loadAccounts(bookGuid: string, types: string[]): Promise<AccountOption[]> {
  const data = await api<{ accounts: AccountOption[] }>(
    `/api/expense-reports/accounts?book=${bookGuid}&types=${types.join(',')}`,
  );
  return data.accounts;
}

export function reportAction<T>(reportId: number, body: Record<string, unknown>): Promise<T> {
  return api<T>(`/api/expense-reports/${reportId}`, { json: body });
}

export const STATUS_CLASS: Record<ReportStatus, string> = {
  submitted: 'border-warning/40 bg-warning/10 text-warning',
  posted: 'border-secondary/40 bg-secondary-light text-secondary',
  paid: 'border-primary/40 bg-primary-light text-primary',
  settled: 'border-positive/40 bg-positive/10 text-positive',
  rejected: 'border-border bg-background-tertiary text-foreground-muted',
  withdrawn: 'border-border bg-background-tertiary text-foreground-muted',
};
