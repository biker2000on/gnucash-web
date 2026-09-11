import type { UtilityBill, UtilityType } from './types';

export interface UtilityTrendMonth {
  month: string;
  billCount: number;
  cost: number | null;
  usage: Partial<Record<UtilityBill['unit'], number>>;
  fees: Record<string, number | null>;
  feeTotal: number | null;
}

const normalize = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/** Never infer zero fees from a bill with no recorded breakdown. */
function billFees(bill: UtilityBill): Map<string, { label: string; amount: number }> | null {
  const charges = bill.charges ?? [];
  if (!charges.length && bill.feeCost == null) return null;
  const fees = new Map<string, { label: string; amount: number }>();
  for (const charge of charges.filter(charge => charge.category === 'fee')) {
    const label = charge.label.trim().replace(/\s+/g, ' ') || 'Unnamed fee';
    const key = normalize(label);
    fees.set(key, { label, amount: (fees.get(key)?.amount ?? 0) + charge.amount });
  }
  const itemized = [...fees.values()].reduce((sum, fee) => sum + fee.amount, 0);
  const residual = bill.feeCost == null ? 0 : round(bill.feeCost - itemized);
  if (residual !== 0) fees.set('__unitemized', { label: 'Unitemized fees', amount: residual });
  return fees;
}

export function buildUtilityTrends(bills: UtilityBill[], filters: {
  type: UtilityType; provider?: string; from?: string; to?: string;
}) {
  const selected = bills.filter(bill => bill.type === filters.type
    && (!filters.provider || bill.provider === filters.provider)
    && (!filters.from || bill.date >= filters.from)
    && (!filters.to || bill.date <= filters.to))
    .slice().sort((a, b) => a.date.localeCompare(b.date));
  const feeLabels = new Map<string, string>();
  const feesByBill = selected.map(bill => {
    const fees = billFees(bill);
    fees?.forEach((fee, key) => { if (!feeLabels.has(key)) feeLabels.set(key, fee.label); });
    return fees;
  });
  // Synthetic keys keep arbitrary extracted labels out of chart property paths.
  const feeTypes = [...feeLabels].sort((a, b) => a[1].localeCompare(b[1]))
    .map(([key, label], index) => ({ key, id: `fee${index}`, label }));
  const units = [...new Set(selected.map(bill => bill.unit))];
  const grouped = new Map<string, number[]>();
  selected.forEach((bill, index) => {
    const month = bill.date.slice(0, 7);
    grouped.set(month, [...(grouped.get(month) ?? []), index]);
  });
  const months: UtilityTrendMonth[] = [];
  if (selected.length) {
    const first = selected[0].date.slice(0, 7);
    const last = selected[selected.length - 1].date.slice(0, 7);
    const cursor = new Date(`${first}-01T00:00:00Z`);
    while (cursor.toISOString().slice(0, 7) <= last) {
      const month = cursor.toISOString().slice(0, 7);
      const indices = grouped.get(month) ?? [];
      const knownFees = indices.length > 0 && indices.every(index => feesByBill[index] !== null);
      const usage: UtilityTrendMonth['usage'] = {};
      for (const index of indices) {
        const bill = selected[index];
        usage[bill.unit] = (usage[bill.unit] ?? 0) + bill.usage;
      }
      const fees = Object.fromEntries(feeTypes.map(fee => [fee.id, knownFees
        && !indices.some(index => fee.key !== '__unitemized' && !feesByBill[index]?.has(fee.key) && feesByBill[index]?.has('__unitemized'))
        ? round(indices.reduce((sum, index) => sum + (feesByBill[index]?.get(fee.key)?.amount ?? 0), 0)) : null]));
      months.push({ month, billCount: indices.length,
        cost: indices.length ? round(indices.reduce((sum, index) => sum + selected[index].totalCost, 0)) : null,
        usage, fees,
        feeTotal: knownFees ? round(indices.reduce((sum, index) => sum + [...feesByBill[index]!.values()].reduce((total, fee) => total + fee.amount, 0), 0)) : null,
      });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }
  const comparisons = feeTypes.map(fee => {
    const known = months.filter(month => month.fees[fee.id] != null);
    const first = known[0];
    const latest = known[known.length - 1];
    const delta = known.length >= 2 ? round(latest.fees[fee.id]! - first.fees[fee.id]!) : null;
    return { ...fee, firstMonth: first?.month, latestMonth: latest?.month,
      first: first?.fees[fee.id] ?? null, latest: latest?.fees[fee.id] ?? null, delta,
      percent: delta !== null && first.fees[fee.id] !== 0 ? delta / Math.abs(first.fees[fee.id]!) * 100 : null };
  });
  return { months, units, feeTypes, comparisons, billCount: selected.length,
    missingBreakdowns: feesByBill.filter(fees => fees === null).length };
}
