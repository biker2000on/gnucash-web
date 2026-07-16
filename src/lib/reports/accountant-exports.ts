/**
 * Accountant workspace exports (S7)
 *
 * CSV bundles an accountant asks for at year end: trial balance, general
 * ledger, and journal. All accounting math is reused from the existing
 * report generators (trial-balance.ts, general-ledger.ts,
 * general-journal.ts) and the existing CSV shapers (csv-export.ts) — this
 * module only adds a small metadata header and the export orchestration.
 */

import { generateTrialBalance } from './trial-balance';
import { generateGeneralLedger } from './general-ledger';
import { generateGeneralJournal } from './general-journal';
import {
  escapeCSVField,
  generateTrialBalanceCSV,
  generateLedgerCSV,
  generateJournalCSV,
} from './csv-export';
import type {
  ReportFilters,
  TrialBalanceData,
  GeneralLedgerData,
  GeneralJournalData,
} from './types';

export type AccountantExportType = 'trial_balance' | 'general_ledger' | 'journal';

export const ACCOUNTANT_EXPORT_TYPES: AccountantExportType[] = [
  'trial_balance',
  'general_ledger',
  'journal',
];

export function isAccountantExportType(value: string | null): value is AccountantExportType {
  return value !== null && (ACCOUNTANT_EXPORT_TYPES as string[]).includes(value);
}

export interface AccountantExport {
  filename: string;
  csv: string;
}

/** Two metadata lines + a blank separator ahead of the CSV table. */
function metadataHeader(title: string, periodLabel: string, generatedAt: string): string {
  return [
    escapeCSVField(title),
    escapeCSVField(`${periodLabel} — generated ${generatedAt.slice(0, 10)}`),
    '',
  ].join('\n');
}

/** Trial balance CSV: as-of balances with debit/credit columns and totals. */
export function trialBalanceCsv(data: TrialBalanceData): string {
  const asOf = data.filters.endDate ?? data.generatedAt.slice(0, 10);
  return metadataHeader('Trial Balance', `As of ${asOf}`, data.generatedAt)
    + '\n' + generateTrialBalanceCSV(data);
}

/** General ledger CSV: per-account listings with opening/closing balances. */
export function generalLedgerCsv(data: GeneralLedgerData): string {
  const period = `Period ${data.filters.startDate ?? '(start)'} to ${data.filters.endDate ?? '(today)'}`;
  return metadataHeader('General Ledger', period, data.generatedAt)
    + '\n' + generateLedgerCSV(data);
}

/** Journal CSV: every transaction with its splits, date ordered. */
export function journalCsv(data: GeneralJournalData): string {
  const period = `Period ${data.filters.startDate ?? '(start)'} to ${data.filters.endDate ?? '(today)'}`;
  return metadataHeader('General Journal', period, data.generatedAt)
    + '\n' + generateJournalCSV(data);
}

/**
 * Generate one accountant export: runs the matching report generator over
 * the given filters and shapes the result as CSV with a dated filename.
 */
export async function generateAccountantExport(
  type: AccountantExportType,
  filters: ReportFilters,
): Promise<AccountantExport> {
  const suffix = filters.endDate ?? new Date().toISOString().slice(0, 10);

  if (type === 'trial_balance') {
    const data = await generateTrialBalance(filters);
    return { filename: `trial-balance-${suffix}.csv`, csv: trialBalanceCsv(data) };
  }
  if (type === 'general_ledger') {
    const data = await generateGeneralLedger(filters);
    return { filename: `general-ledger-${suffix}.csv`, csv: generalLedgerCsv(data) };
  }
  const data = await generateGeneralJournal(filters);
  return { filename: `journal-${suffix}.csv`, csv: journalCsv(data) };
}
