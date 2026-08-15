import { describe, expect, it } from 'vitest';
import { buildCapitalGainsReport, type RealizedSaleInput } from '@/lib/reports/capital-gains';
import { buildTxfFile } from '../txf-file';
import { capitalGainsTxfItems } from '../txf-capital-gains';

describe('capitalGainsTxfItems', () => {
  it('uses the existing report net totals and preserves short- versus long-term TXF codes', () => {
    const sales: RealizedSaleInput[] = [
      { splitGuid: 's'.repeat(32), accountGuid: 'a'.repeat(32), ticker: 'SHORT', shares: 1, dateAcquired: '2025-01-01', dateSold: '2025-06-01', proceeds: 900, costBasis: 1_000 },
      { splitGuid: 'l'.repeat(32), accountGuid: 'a'.repeat(32), ticker: 'LONG', shares: 1, dateAcquired: '2023-01-01', dateSold: '2025-06-01', proceeds: 2_400, costBasis: 1_000 },
    ];
    const report = buildCapitalGainsReport(sales, [], 2025);
    const items = capitalGainsTxfItems(report);

    expect(items).toEqual([
      expect.objectContaining({ code: 'N684', total: report.scheduleD.netShortTerm }),
      expect.objectContaining({ code: 'N683', total: report.scheduleD.netLongTerm }),
    ]);
    const txf = buildTxfFile(items, { date: new Date(2026, 0, 1) });
    expect(txf).toContain('N684\r\nC1\r\nL1\r\n$-100.00');
    expect(txf).toContain('N683\r\nC1\r\nL1\r\n$1400.00');
  });
});
