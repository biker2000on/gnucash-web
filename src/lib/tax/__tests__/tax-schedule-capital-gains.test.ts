import { describe, expect, it } from 'vitest';
import { addCapitalGainsToTaxSchedule } from '../tax-schedule-capital-gains';
import { buildCapitalGainsReport } from '@/lib/reports/capital-gains';

const schedule = (codes: string[] = []) => ({
  year: 2025, generatedAt: '2026-01-01T00:00:00Z', unmappedTaxRelated: [], overrides: {},
  items: codes.map(code => ({ code, form: 'Schedule D', line: 'Part I', description: 'Mapped', sign: 'income' as const, payerSupported: false, accounts: [], total: 10 })),
});

describe('addCapitalGainsToTaxSchedule', () => {
  it('adds authoritative Schedule D totals and carries filing warnings to JSON', () => {
    const gains = buildCapitalGainsReport([{ splitGuid: 's'.repeat(32), accountGuid: 'a'.repeat(32), ticker: 'ABC', shares: 1, dateAcquired: '2025-01-01', dateSold: '2025-02-01', proceeds: 200, costBasis: 100 }], [], 2025);
    const result = addCapitalGainsToTaxSchedule(schedule(), gains);
    expect(result.items.map(item => item.code)).toContain('N684');
    expect(result.capitalGainsCollisionCodes).toEqual([]);
  });

  it('detects an account-mapping collision instead of silently duplicating N683/N684', () => {
    const gains = buildCapitalGainsReport([{ splitGuid: 'l'.repeat(32), accountGuid: 'a'.repeat(32), ticker: 'ABC', shares: 1, dateAcquired: '2023-01-01', dateSold: '2025-02-01', proceeds: 200, costBasis: 100 }], [], 2025);
    const result = addCapitalGainsToTaxSchedule(schedule(['N683']), gains);
    expect(result.capitalGainsCollisionCodes).toEqual(['N683']);
    expect(result.items.filter(item => item.code === 'N683')).toHaveLength(1);
  });
});
