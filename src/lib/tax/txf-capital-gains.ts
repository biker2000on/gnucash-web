/**
 * TXF export adapter for the already-authoritative capital-gains report.
 * N684 receives the report's short-term Schedule D net and N683 its long-term
 * net; these codes are defined in txf-codes.ts. No sale, basis, commission, or
 * wash-sale arithmetic is duplicated here.
 */

import type { CapitalGainsReport } from '@/lib/reports/capital-gains';
import type { TxfExportItem } from './txf-file';

export function capitalGainsTxfItems(report: CapitalGainsReport): TxfExportItem[] {
  return [
    { code: 'N684', payerSupported: false, total: report.scheduleD.netShortTerm, accounts: [] },
    { code: 'N683', payerSupported: false, total: report.scheduleD.netLongTerm, accounts: [] },
  ];
}
