import type {
  CapitalAsset,
  HealthcareClaim,
  HealthcarePlan,
  InsurancePolicy,
  LifePerson,
  MileagePurpose,
  MileageTrip,
  PersonalPriceIndexItem,
  ReceiptPriceObservation,
  RentalProperty,
} from './types';

const DAY_MS = 86_400_000;

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function validDate(value: string): Date | null {
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function calculateRentRoll(properties: RentalProperty[], asOf = new Date()) {
  const month = asOf.toISOString().slice(0, 7);
  const rows = properties.flatMap(property => property.units.map(unit => {
    const paidThisMonth = unit.payments
      .filter(payment => payment.kind === 'rent' && payment.date.startsWith(month))
      .reduce((sum, payment) => sum + payment.amount, 0);
    const balance = round2(Math.max(0, unit.monthlyRent - paidThisMonth));
    const dueDate = `${month}-${String(Math.min(28, Math.max(1, unit.rentDueDay))).padStart(2, '0')}`;
    const overdue = balance > 0 && dueDate < asOf.toISOString().slice(0, 10);
    const leaseEnd = validDate(unit.leaseEnd);
    const daysToRenewal = leaseEnd ? Math.ceil((leaseEnd.getTime() - asOf.getTime()) / DAY_MS) : null;
    return {
      propertyId: property.id,
      propertyName: property.name,
      unitId: unit.id,
      unitName: unit.name,
      tenantName: unit.tenantName,
      monthlyRent: unit.monthlyRent,
      paidThisMonth: round2(paidThisMonth),
      balance,
      dueDate,
      overdue,
      leaseEnd: unit.leaseEnd,
      daysToRenewal,
      securityDeposit: unit.securityDeposit,
    };
  }));
  return {
    rows,
    monthlyScheduledRent: round2(rows.reduce((sum, row) => sum + row.monthlyRent, 0)),
    collectedThisMonth: round2(rows.reduce((sum, row) => sum + row.paidThisMonth, 0)),
    outstanding: round2(rows.reduce((sum, row) => sum + row.balance, 0)),
    depositLiability: round2(rows.reduce((sum, row) => sum + row.securityDeposit, 0)),
  };
}

export function calculateCoverageGap(
  policies: InsurancePolicy[],
  inventory: Array<{ category: string | null; estValue: number | null }>,
) {
  const replacementValue = round2(inventory.reduce((sum, item) => sum + Math.max(0, item.estValue ?? 0), 0));
  const propertyPolicies = policies.filter(policy => policy.type === 'home' || policy.type === 'renters');
  const coverageLimit = round2(propertyPolicies.reduce((sum, policy) => sum + policy.coverageLimit, 0));
  const categories = new Map<string, number>();
  for (const item of inventory) {
    const category = (item.category || 'Uncategorized').trim();
    categories.set(category, round2((categories.get(category) ?? 0) + Math.max(0, item.estValue ?? 0)));
  }
  const sublimits = new Map<string, number>();
  for (const policy of propertyPolicies) {
    for (const sublimit of policy.sublimits) {
      const key = sublimit.category.trim().toLowerCase();
      sublimits.set(key, round2((sublimits.get(key) ?? 0) + sublimit.limit));
    }
  }
  const categoryGaps = [...categories.entries()].flatMap(([category, value]) => {
    const limit = sublimits.get(category.toLowerCase());
    if (limit == null || value <= limit) return [];
    return [{ category, inventoryValue: value, limit, gap: round2(value - limit) }];
  });
  return {
    replacementValue,
    coverageLimit,
    gap: round2(Math.max(0, replacementValue - coverageLimit)),
    surplus: round2(Math.max(0, coverageLimit - replacementValue)),
    categoryGaps,
  };
}

export function calculateCapitalPlan(assets: CapitalAsset[], asOf = new Date()) {
  const currentYear = asOf.getUTCFullYear();
  const rows = assets.map(asset => {
    const replacementYear = asset.installedYear + asset.expectedLifeYears;
    const yearsRemaining = Math.max(0, replacementYear - currentYear);
    const futureCost = round2(asset.currentReplacementCost * ((1 + asset.inflationRate / 100) ** yearsRemaining));
    const fundingGap = round2(Math.max(0, futureCost - asset.fundedAmount));
    const monthsRemaining = Math.max(1, yearsRemaining * 12);
    return {
      ...asset,
      replacementYear,
      yearsRemaining,
      futureCost,
      fundingGap,
      monthlyFunding: round2(fundingGap / monthsRemaining),
      overdue: replacementYear <= currentYear,
    };
  }).sort((a, b) => a.replacementYear - b.replacementYear || a.name.localeCompare(b.name));
  return {
    rows,
    futureCost: round2(rows.reduce((sum, row) => sum + row.futureCost, 0)),
    fundingGap: round2(rows.reduce((sum, row) => sum + row.fundingGap, 0)),
    monthlyFunding: round2(rows.reduce((sum, row) => sum + row.monthlyFunding, 0)),
  };
}

export function calculateLifeNeeds(person: LifePerson) {
  const incomeReplacement = round2(person.annualIncome * person.replacementYears);
  const dimeNeed = round2(
    person.debts + incomeReplacement + person.educationGoals + person.finalExpenses,
  );
  const dimeGap = round2(Math.max(0, dimeNeed - person.liquidAssets - person.existingCoverage));
  const survivorAnnualGap = Math.max(0, person.survivorAnnualExpenses - person.survivorAnnualIncome);
  const survivorNeed = round2(
    person.debts
      + person.educationGoals
      + person.finalExpenses
      + survivorAnnualGap * person.replacementYears,
  );
  const survivorGap = round2(Math.max(0, survivorNeed - person.liquidAssets - person.existingCoverage));
  return {
    person,
    incomeReplacement,
    dimeNeed,
    dimeGap,
    survivorAnnualGap: round2(survivorAnnualGap),
    survivorNeed,
    survivorGap,
    recommendedCoverage: Math.max(dimeGap, survivorGap),
  };
}

export function simulateHealthPlan(plan: HealthcarePlan, claims: HealthcareClaim[]) {
  const allowed = round2(claims.reduce((sum, claim) => sum + Math.max(0, claim.allowedAmount), 0));
  const deductibleSpend = Math.min(plan.familyDeductible, allowed);
  const postDeductible = Math.max(0, allowed - deductibleSpend);
  const coinsuranceSpend = postDeductible * Math.min(1, Math.max(0, plan.coinsurancePercent / 100));
  const memberMedicalCost = round2(Math.min(plan.outOfPocketMax, deductibleSpend + coinsuranceSpend));
  const hsaTaxSavings = plan.hsaEligible
    ? round2(plan.employeeHsaContribution * Math.min(1, Math.max(0, plan.marginalTaxRate / 100)))
    : 0;
  const netAnnualCost = round2(
    plan.annualPremium + memberMedicalCost - plan.employerHsaContribution - hsaTaxSavings,
  );
  return { plan, allowed, memberMedicalCost, hsaTaxSavings, netAnnualCost };
}

export function compareHealthPlans(plans: HealthcarePlan[], claims: HealthcareClaim[]) {
  const rows = plans.map(plan => simulateHealthPlan(plan, claims))
    .sort((a, b) => a.netAnnualCost - b.netAnnualCost);
  const best = rows[0]?.netAnnualCost ?? 0;
  return rows.map(row => ({ ...row, differenceFromBest: round2(row.netAnnualCost - best) }));
}

interface MileageRatePeriod {
  from: string;
  to: string;
  business: number;
  medical: number;
  charity: number;
}

// Rates are dollars per mile. 2026 changed mid-year under Announcement 2026-11.
export const IRS_MILEAGE_RATES: MileageRatePeriod[] = [
  { from: '2024-01-01', to: '2024-12-31', business: 0.67, medical: 0.21, charity: 0.14 },
  { from: '2025-01-01', to: '2025-12-31', business: 0.70, medical: 0.21, charity: 0.14 },
  { from: '2026-01-01', to: '2026-06-30', business: 0.725, medical: 0.205, charity: 0.14 },
  { from: '2026-07-01', to: '2026-12-31', business: 0.76, medical: 0.235, charity: 0.14 },
];

export function mileageRate(date: string, purpose: MileagePurpose): number {
  if (purpose === 'personal') return 0;
  const period = IRS_MILEAGE_RATES.find(rate => date >= rate.from && date <= rate.to);
  if (!period) return 0;
  return purpose === 'business'
    ? period.business
    : purpose === 'medical'
      ? period.medical
      : period.charity;
}

export function summarizeMileage(trips: MileageTrip[], year: number) {
  const rows = trips.filter(trip => trip.date.startsWith(String(year))).map(trip => ({
    ...trip,
    rate: mileageRate(trip.date, trip.purpose),
    deduction: round2(trip.miles * mileageRate(trip.date, trip.purpose)),
  }));
  const bySchedule = ['C', 'E', 'F', 'none'].map(schedule => ({
    schedule,
    miles: round2(rows.filter(row => row.schedule === schedule).reduce((sum, row) => sum + row.miles, 0)),
    deduction: round2(rows.filter(row => row.schedule === schedule).reduce((sum, row) => sum + row.deduction, 0)),
  }));
  return {
    rows,
    totalMiles: round2(rows.reduce((sum, row) => sum + row.miles, 0)),
    deductibleMiles: round2(rows.filter(row => row.purpose !== 'personal').reduce((sum, row) => sum + row.miles, 0)),
    deduction: round2(rows.reduce((sum, row) => sum + row.deduction, 0)),
    bySchedule,
  };
}

export function normalizeReceiptItem(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\s*(oz|lb|lbs|ct|pk|pack|gal|ml|l)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(organic|fresh|large|small|medium)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseReceiptPriceLines(input: {
  receiptId: number;
  date: string;
  merchant: string | null;
  text: string;
}): ReceiptPriceObservation[] {
  const observations: ReceiptPriceObservation[] = [];
  for (const raw of input.text.split(/\r?\n/)) {
    const line = raw.trim();
    const match = line.match(/^(.{2,80}?)\s+(?:(\d+(?:\.\d+)?)\s*[xX@]\s*)?\$?(\d{1,6}(?:\.\d{2,4}))$/);
    if (!match) continue;
    const rawName = match[1].replace(/\s+/g, ' ').trim();
    if (/^(sub\s*total|subtotal|total|tax|change|cash|credit|debit|balance)$/i.test(rawName)) continue;
    const quantity = match[2] ? Number(match[2]) : 1;
    const total = Number(match[3]);
    const normalizedName = normalizeReceiptItem(rawName);
    if (!normalizedName || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(total) || total <= 0) continue;
    observations.push({
      receiptId: input.receiptId,
      date: input.date,
      merchant: input.merchant,
      rawName,
      normalizedName,
      quantity,
      unitPrice: round2(total / quantity),
      total: round2(total),
    });
  }
  return observations;
}

export function buildPersonalPriceIndex(observations: ReceiptPriceObservation[]): {
  items: PersonalPriceIndexItem[];
  weightedChangePercent: number;
} {
  const groups = new Map<string, ReceiptPriceObservation[]>();
  for (const observation of observations) {
    const list = groups.get(observation.normalizedName) ?? [];
    list.push(observation);
    groups.set(observation.normalizedName, list);
  }
  const items = [...groups.entries()].flatMap(([normalizedName, list]) => {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    if (sorted.length < 2) return [];
    const first = sorted[0];
    const latest = sorted[sorted.length - 1];
    const changePercent = first.unitPrice === 0 ? 0 : ((latest.unitPrice / first.unitPrice) - 1) * 100;
    const days = Math.max(1, (validDate(latest.date)!.getTime() - validDate(first.date)!.getTime()) / DAY_MS);
    const annualizedPercent = days < 30
      ? null
      : (((latest.unitPrice / first.unitPrice) ** (365 / days)) - 1) * 100;
    return [{
      normalizedName,
      latestName: latest.rawName,
      observations: sorted.length,
      firstDate: first.date,
      latestDate: latest.date,
      firstUnitPrice: first.unitPrice,
      latestUnitPrice: latest.unitPrice,
      changePercent: round2(changePercent),
      annualizedPercent: annualizedPercent == null ? null : round2(annualizedPercent),
      receiptIds: [...new Set(sorted.map(item => item.receiptId))],
    }];
  }).sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
  const weightedChangePercent = items.length === 0
    ? 0
    : round2(items.reduce((sum, item) => sum + item.changePercent * item.observations, 0)
      / items.reduce((sum, item) => sum + item.observations, 0));
  return { items, weightedChangePercent };
}
