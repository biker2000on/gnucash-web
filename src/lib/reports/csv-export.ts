import { ReportData, TrialBalanceData, GeneralLedgerData, InvestmentPortfolioData, GeneralJournalData, ChartReportData } from './types';

/**
 * Escape a CSV field value.
 * Wraps in double quotes if the value contains commas, quotes, or newlines.
 * Internal double quotes are escaped by doubling them.
 */
export function escapeCSVField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Generate CSV string from ReportData.
 * Handles comparison columns when previous period data exists.
 */
export function generateCSV(data: ReportData): string {
  const rows: string[] = [];
  const hasCompare = data.sections.some(s => s.previousTotal !== undefined);

  // Header row
  if (hasCompare) {
    rows.push('Section,Item,Current Amount,Previous Amount');
  } else {
    rows.push('Section,Item,Amount');
  }

  for (const section of data.sections) {
    // Section header
    rows.push(escapeCSVField(section.title) + ',,');

    for (const item of section.items) {
      const name = item.depth ? '  '.repeat(item.depth) + item.name : item.name;
      if (hasCompare) {
        rows.push(`,"${name.replace(/"/g, '""')}",${item.amount},${item.previousAmount ?? ''}`);
      } else {
        rows.push(`,"${name.replace(/"/g, '""')}",${item.amount}`);
      }
    }

    // Section total
    if (hasCompare) {
      rows.push(`,${escapeCSVField('TOTAL: ' + section.title)},${section.total},${section.previousTotal ?? ''}`);
    } else {
      rows.push(`,${escapeCSVField('TOTAL: ' + section.title)},${section.total}`);
    }

    // Blank line between sections
    rows.push('');
  }

  // Grand total
  if (data.grandTotal !== undefined) {
    if (hasCompare) {
      rows.push(`,"GRAND TOTAL",${data.grandTotal},${data.previousGrandTotal ?? ''}`);
    } else {
      rows.push(`,"GRAND TOTAL",${data.grandTotal}`);
    }
  }

  return rows.join('\n');
}

/**
 * Generate CSV string from TrialBalanceData.
 */
export function generateTrialBalanceCSV(data: TrialBalanceData): string {
  const rows: string[] = ['Account,Account Type,Debit,Credit'];
  for (const entry of data.entries) {
    rows.push(`${escapeCSVField(entry.accountPath)},${escapeCSVField(entry.accountType)},${entry.debit || ''},${entry.credit || ''}`);
  }
  rows.push('');
  rows.push(`,"TOTALS",${data.totalDebits},${data.totalCredits}`);
  return rows.join('\n');
}

/**
 * Generate CSV string from GeneralLedgerData.
 */
export function generateLedgerCSV(data: GeneralLedgerData): string {
  const rows: string[] = ['Account,Date,Description,Debit,Credit,Balance'];
  for (const account of data.accounts) {
    rows.push(`${escapeCSVField(account.accountPath)},Opening Balance,,,${account.openingBalance}`);
    for (const entry of account.entries) {
      rows.push([
        '',
        escapeCSVField(entry.date),
        escapeCSVField(entry.description),
        entry.debit || '',
        entry.credit || '',
        entry.runningBalance,
      ].join(','));
    }
    rows.push(`${escapeCSVField(account.accountPath)},Closing Balance,,,${account.closingBalance}`);
    rows.push('');
  }
  rows.push(`,"TOTALS",,${data.totalDebits},${data.totalCredits},`);
  return rows.join('\n');
}

/**
 * Generate CSV string from InvestmentPortfolioData.
 */
export function generatePortfolioCSV(data: InvestmentPortfolioData): string {
  const rows: string[] = ['Account,Symbol,Shares,Price,Price Date,Market Value,Cost Basis,Gain/Loss,Gain %'];
  for (const h of data.holdings) {
    rows.push([
      escapeCSVField(h.accountName),
      escapeCSVField(h.symbol),
      h.shares,
      h.latestPrice,
      escapeCSVField(h.priceDate),
      h.marketValue.toFixed(2),
      h.costBasis.toFixed(2),
      h.gain.toFixed(2),
      h.gainPercent.toFixed(2) + '%',
    ].join(','));
  }
  rows.push('');
  rows.push(`"TOTALS",,,,,${data.totals.marketValue.toFixed(2)},${data.totals.costBasis.toFixed(2)},${data.totals.gain.toFixed(2)},${data.totals.gainPercent.toFixed(2)}%`);
  return rows.join('\n');
}

/**
 * Generate CSV string from GeneralJournalData.
 */
export function generateJournalCSV(data: GeneralJournalData): string {
  const rows: string[] = ['Date,Description,Num,Account,Debit,Credit,Memo'];
  for (const entry of data.entries) {
    for (const split of entry.splits) {
      rows.push([
        escapeCSVField(entry.date),
        escapeCSVField(entry.description),
        escapeCSVField(entry.num),
        escapeCSVField(split.accountPath),
        split.debit ? split.debit.toFixed(2) : '',
        split.credit ? split.credit.toFixed(2) : '',
        escapeCSVField(split.memo),
      ].join(','));
    }
  }
  rows.push('');
  rows.push(`,,,"TOTALS",${data.totalDebits.toFixed(2)},${data.totalCredits.toFixed(2)},`);
  return rows.join('\n');
}

/**
 * Generate CSV string from ChartReportData.
 */
export function generateChartCSV(data: ChartReportData): string {
  const rows: string[] = ['Date,' + data.series.join(',')];
  for (const point of data.dataPoints) {
    const values = data.series.map(s => point[s] ?? '');
    rows.push(escapeCSVField(point.date) + ',' + values.join(','));
  }
  return rows.join('\n');
}

/**
 * Trigger a CSV file download in the browser.
 */
export function downloadCSV(content: string, filename: string): void {
  const blob = new Blob(['\ufeff' + content], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}
