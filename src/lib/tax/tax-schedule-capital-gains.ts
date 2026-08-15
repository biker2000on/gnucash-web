import type { CapitalGainsReport } from '@/lib/reports/capital-gains';
import type { TaxScheduleLineItem, TaxScheduleReport } from './tax-schedule';
import { capitalGainsTxfItems } from './txf-capital-gains';

export interface TaxScheduleWithCapitalGains extends TaxScheduleReport {
  capitalGainsWarnings: string[];
  capitalGainsCollisionCodes: string[];
}

/** Add the authoritative Schedule D totals unless account mapping already owns the same TXF code. */
export function addCapitalGainsToTaxSchedule(
  schedule: TaxScheduleReport,
  capitalGains: CapitalGainsReport,
): TaxScheduleWithCapitalGains {
  const capitalItems: TaxScheduleLineItem[] = capitalGainsTxfItems(capitalGains).map(item => ({
    code: item.code,
    form: 'Schedule D',
    line: item.code === 'N684' ? 'Part I' : 'Part II',
    description: item.code === 'N684' ? 'Short-term gain/loss (1099-B)' : 'Long-term gain/loss (1099-B)',
    sign: 'income',
    payerSupported: false,
    accounts: [],
    total: item.total,
  }));
  const nonzeroCapitalItems = capitalItems.filter(item => Math.round(item.total * 100) !== 0);
  const existingCodes = new Set(schedule.items.map(item => item.code));
  const collisions = nonzeroCapitalItems.filter(item => existingCodes.has(item.code)).map(item => item.code);
  return {
    ...schedule,
    items: [...schedule.items, ...nonzeroCapitalItems.filter(item => !collisions.includes(item.code))],
    capitalGainsWarnings: capitalGains.warnings,
    capitalGainsCollisionCodes: collisions,
  };
}
