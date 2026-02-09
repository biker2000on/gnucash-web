import { ReportData } from './types';

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
