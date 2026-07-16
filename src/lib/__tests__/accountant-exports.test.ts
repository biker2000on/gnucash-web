/**
 * Accountant workspace exports — CSV shaping tests (DB-free).
 *
 * The accounting math lives in the existing report generators; these tests
 * cover the CSV shaping: metadata headers, table rows, and — critically —
 * that a balanced trial balance emits equal debit and credit totals.
 */

import { describe, it, expect } from 'vitest';
import {
  trialBalanceCsv,
  generalLedgerCsv,
  journalCsv,
  isAccountantExportType,
} from '@/lib/reports/accountant-exports';
import {
  ReportType,
  type TrialBalanceData,
  type GeneralLedgerData,
  type GeneralJournalData,
  type ReportFilters,
} from '@/lib/reports/types';

const filters: ReportFilters = {
  startDate: '2026-01-01',
  endDate: '2026-06-30',
};

function trialBalanceFixture(): TrialBalanceData {
  const entries = [
    { guid: 'a1', accountPath: 'Assets:Checking', accountType: 'BANK', debit: 1200.5, credit: 0 },
    { guid: 'e1', accountPath: 'Expenses:Rent, Office', accountType: 'EXPENSE', debit: 800, credit: 0 },
    { guid: 'i1', accountPath: 'Income:Consulting', accountType: 'INCOME', debit: 0, credit: 1500.5 },
    { guid: 'l1', accountPath: 'Liabilities:Card', accountType: 'CREDIT', debit: 0, credit: 500 },
  ];
  const totalDebits = Math.round(entries.reduce((s, e) => s + e.debit, 0) * 100) / 100;
  const totalCredits = Math.round(entries.reduce((s, e) => s + e.credit, 0) * 100) / 100;
  return {
    type: ReportType.TRIAL_BALANCE,
    title: 'Trial Balance',
    generatedAt: '2026-07-16T12:00:00.000Z',
    filters,
    entries,
    totalDebits,
    totalCredits,
  };
}

describe('trialBalanceCsv', () => {
  it('emits balanced totals (debits = credits)', () => {
    const csv = trialBalanceCsv(trialBalanceFixture());
    const totals = csv.split('\n').find((l) => l.includes('"TOTALS"'));
    expect(totals).toBeDefined();
    const [, , debits, credits] = totals!.split(',');
    expect(debits).toBe(credits);
    expect(Number(debits)).toBe(2000.5);
  });

  it('includes the metadata header, column header, and one row per account', () => {
    const csv = trialBalanceCsv(trialBalanceFixture());
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Trial Balance');
    expect(lines[1]).toContain('As of 2026-06-30');
    expect(lines[1]).toContain('generated 2026-07-16');
    expect(csv).toContain('Account,Account Type,Debit,Credit');
    // Comma-containing account paths are quoted
    expect(csv).toContain('"Expenses:Rent, Office",EXPENSE,800,');
    expect(csv).toContain('Income:Consulting,INCOME,,1500.5');
  });
});

describe('generalLedgerCsv', () => {
  it('shapes per-account sections with opening/closing balances and totals', () => {
    const data: GeneralLedgerData = {
      type: ReportType.GENERAL_LEDGER,
      title: 'General Ledger',
      generatedAt: '2026-07-16T12:00:00.000Z',
      filters,
      accounts: [
        {
          guid: 'a1',
          accountPath: 'Assets:Checking',
          accountType: 'BANK',
          openingBalance: 100,
          entries: [
            { date: '2026-02-01', description: 'Deposit', debit: 250, credit: 0, runningBalance: 350, memo: '' },
            { date: '2026-03-01', description: 'Rent', debit: 0, credit: 200, runningBalance: 150, memo: 'Feb' },
          ],
          closingBalance: 150,
        },
      ],
      totalDebits: 250,
      totalCredits: 200,
    };
    const csv = generalLedgerCsv(data);
    expect(csv.split('\n')[0]).toBe('General Ledger');
    expect(csv).toContain('Period 2026-01-01 to 2026-06-30');
    expect(csv).toContain('Assets:Checking,Opening Balance,,,100');
    expect(csv).toContain(',2026-02-01,Deposit,250,,350');
    expect(csv).toContain('Assets:Checking,Closing Balance,,,150');
    expect(csv).toContain(',"TOTALS",,250,200,');
  });
});

describe('journalCsv', () => {
  it('emits one row per split with balanced transaction totals', () => {
    const data: GeneralJournalData = {
      type: ReportType.GENERAL_JOURNAL,
      title: 'General Journal',
      generatedAt: '2026-07-16T12:00:00.000Z',
      filters,
      entries: [
        {
          transactionGuid: 't1',
          date: '2026-04-15',
          description: 'Client payment',
          num: '42',
          splits: [
            { accountPath: 'Assets:Checking', debit: 1000, credit: 0, memo: '' },
            { accountPath: 'Income:Consulting', debit: 0, credit: 1000, memo: 'April' },
          ],
        },
      ],
      totalDebits: 1000,
      totalCredits: 1000,
      entryCount: 1,
    };
    const csv = journalCsv(data);
    expect(csv.split('\n')[0]).toBe('General Journal');
    expect(csv).toContain('2026-04-15,Client payment,42,Assets:Checking,1000.00,,');
    expect(csv).toContain('2026-04-15,Client payment,42,Income:Consulting,,1000.00,April');
    expect(csv).toContain(',,,"TOTALS",1000.00,1000.00,');
  });
});

describe('isAccountantExportType', () => {
  it('accepts the three export types and rejects everything else', () => {
    expect(isAccountantExportType('trial_balance')).toBe(true);
    expect(isAccountantExportType('general_ledger')).toBe(true);
    expect(isAccountantExportType('journal')).toBe(true);
    expect(isAccountantExportType('balance_sheet')).toBe(false);
    expect(isAccountantExportType(null)).toBe(false);
  });
});
