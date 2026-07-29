import type {
  EducationChild,
  FamilyBankChild,
  TripPlan,
  UtilitiesProfile,
  UtilityBill,
  UtilityType,
  VehicleTcoAsset,
} from './types';

const MONTHS_PER_YEAR = 12;

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculateEducationPlan(child: EducationChild, asOf = new Date()) {
  const currentYear = asOf.getUTCFullYear();
  const yearsRemaining = Math.max(0, child.collegeStartYear - currentYear);
  const annualReturn = child.expectedAnnualReturn / 100;
  const tuitionInflation = child.tuitionInflationRate / 100;
  const annualCosts = Array.from({ length: child.yearsOfSchool }, (_, index) =>
    child.annualCostToday * ((1 + tuitionInflation) ** (yearsRemaining + index)));
  const projectedCost = round2(annualCosts.reduce((sum, cost) => sum + cost, 0));
  const futureCurrentBalance = child.current529Balance * ((1 + annualReturn) ** yearsRemaining);
  const months = yearsRemaining * MONTHS_PER_YEAR;
  const monthlyRate = annualReturn / MONTHS_PER_YEAR;
  const contributionFactor = months === 0
    ? 0
    : monthlyRate === 0
      ? months
      : (((1 + monthlyRate) ** months) - 1) / monthlyRate;
  const plannedContributionValue = child.plannedMonthlyContribution * contributionFactor;
  const projected529Balance = round2(futureCurrentBalance + plannedContributionValue);
  const fundingGap = round2(Math.max(0, projectedCost - projected529Balance));
  const requiredMonthlyContribution = contributionFactor > 0
    ? round2(Math.max(0, (projectedCost - futureCurrentBalance) / contributionFactor))
    : fundingGap;
  const contributionYear = String(currentYear);
  const contributedThisYear = round2(child.contributions
    .filter(item => item.date.startsWith(contributionYear))
    .reduce((sum, item) => sum + item.amount, 0));
  const stateDeductionRemaining = round2(Math.max(0, child.stateDeductionLimit - contributedThisYear));
  const equityGuidance = yearsRemaining > 10 ? 80 : yearsRemaining > 6 ? 60 : yearsRemaining > 3 ? 40 : 20;
  return {
    ...child,
    yearsRemaining,
    annualCosts: annualCosts.map(round2),
    projectedCost,
    projected529Balance,
    fundingGap,
    requiredMonthlyContribution,
    plannedMonthlyContribution: child.plannedMonthlyContribution,
    monthlyShortfall: round2(Math.max(0, requiredMonthlyContribution - child.plannedMonthlyContribution)),
    contributedThisYear,
    stateDeductionRemaining,
    glidePath: {
      equityPercent: equityGuidance,
      fixedIncomePercent: 100 - equityGuidance,
      guidance: yearsRemaining <= 3
        ? 'Preserve near-term tuition with a conservative allocation.'
        : 'Reduce equity exposure as enrollment approaches.',
    },
  };
}

function utilityRate(bill: UtilityBill): number {
  return bill.usage > 0 ? bill.totalCost / bill.usage : 0;
}

export function calculateUtilityAnalysis(bills: UtilityBill[]) {
  const byType = (['electric', 'gas', 'water'] as const).map(type => {
    const rows = bills.filter(bill => bill.type === type).sort((a, b) => a.date.localeCompare(b.date));
    const latest = rows.at(-1) ?? null;
    const previous = rows.at(-2) ?? null;
    const latestRate = latest ? utilityRate(latest) : 0;
    const previousRate = previous ? utilityRate(previous) : 0;
    const usageChangePercent = latest && previous && previous.usage > 0
      ? ((latest.usage / previous.usage) - 1) * 100
      : 0;
    const rateChangePercent = latestRate > 0 && previousRate > 0
      ? ((latestRate / previousRate) - 1) * 100
      : 0;
    return {
      type,
      bills: rows,
      latest,
      previous,
      latestRate: round2(latestRate),
      usageChangePercent: round2(usageChangePercent),
      rateChangePercent: round2(rateChangePercent),
      trailing12Cost: round2(rows.slice(-12).reduce((sum, bill) => sum + bill.totalCost, 0)),
      trailing12Usage: round2(rows.slice(-12).reduce((sum, bill) => sum + bill.usage, 0)),
    };
  });
  return {
    byType,
    trailing12Cost: round2(byType.reduce((sum, row) => sum + row.trailing12Cost, 0)),
  };
}

export function parseUtilityBillText(input: {
  receiptId: number;
  date: string;
  provider: string;
  text: string;
}): UtilityBill | null {
  const usageMatch = input.text.match(/([\d,]+(?:\.\d+)?)\s*(kwh|therms?|gallons?|gal)\b/i);
  if (!usageMatch) return null;
  const amountMatches = [...input.text.matchAll(/(?:amount due|total due|total|new charges)\s*:?\s*\$?\s*([\d,]+(?:\.\d{2}))/gi)];
  const fallbackAmounts = [...input.text.matchAll(/\$\s*([\d,]+(?:\.\d{2}))/g)];
  const amountText = amountMatches.at(-1)?.[1] ?? fallbackAmounts.at(-1)?.[1];
  if (!amountText) return null;
  const rawUnit = usageMatch[2].toLowerCase();
  const type: UtilityType = rawUnit === 'kwh' ? 'electric' : rawUnit.startsWith('therm') ? 'gas' : 'water';
  const unit: UtilityBill['unit'] = type === 'electric' ? 'kWh' : type === 'gas' ? 'therms' : 'gallons';
  const usage = Number(usageMatch[1].replaceAll(',', ''));
  const totalCost = Number(amountText.replaceAll(',', ''));
  if (!Number.isFinite(usage) || usage <= 0 || !Number.isFinite(totalCost) || totalCost <= 0) return null;
  return {
    id: `receipt-${input.receiptId}-${type}`,
    date: input.date.slice(0, 10),
    type,
    provider: input.provider,
    usage,
    unit,
    totalCost,
    transactionGuid: null,
    receiptId: input.receiptId,
  };
}

export function calculateSolarPayback(profile: UtilitiesProfile) {
  const analysis = calculateUtilityAnalysis(profile.bills);
  const electric = analysis.byType.find(row => row.type === 'electric');
  const currentRate = electric?.latestRate ?? 0;
  const upfrontCost = Math.max(0, profile.solar.systemCost - profile.solar.incentives);
  let cumulativeSavings = 0;
  let paybackYear: number | null = null;
  const cashFlows = Array.from({ length: profile.solar.analysisYears }, (_, index) => {
    const year = index + 1;
    const production = profile.solar.annualProductionKwh
      * ((1 - profile.solar.degradationRate / 100) ** index);
    const rate = currentRate * ((1 + profile.solar.electricRateInflation / 100) ** index);
    const grossSavings = production * rate;
    const netSavings = grossSavings - profile.solar.annualMaintenance;
    cumulativeSavings += netSavings;
    if (paybackYear == null && cumulativeSavings >= upfrontCost) paybackYear = year;
    return {
      year,
      production: round2(production),
      avoidedUtilityCost: round2(grossSavings),
      netSavings: round2(netSavings),
      cumulativeSavings: round2(cumulativeSavings),
    };
  });
  return {
    currentElectricRate: round2(currentRate),
    upfrontCost: round2(upfrontCost),
    paybackYear,
    lifetimeSavings: round2(cumulativeSavings - upfrontCost),
    cashFlows,
  };
}

export function calculateFamilyBanking(child: FamilyBankChild, asOf = new Date()) {
  const approved = child.entries.filter(entry => entry.approved);
  const pending = child.entries.filter(entry => !entry.approved);
  const balance = round2(approved.reduce((sum, entry) => sum + entry.amount, 0));
  const savedDeposits = approved
    .filter(entry => entry.kind === 'deposit')
    .reduce((sum, entry) => sum + Math.max(0, entry.amount), 0);
  const matchingEarned = round2(savedDeposits * child.parentMatchPercent / 100);
  const goalRemaining = round2(Math.max(0, child.savingsGoal - balance));
  const nextAllowance = new Date(`${child.nextAllowanceDate}T12:00:00Z`);
  const allowanceDue = !Number.isNaN(nextAllowance.getTime()) && nextAllowance <= asOf;
  return {
    child,
    balance,
    pendingAmount: round2(pending.reduce((sum, entry) => sum + entry.amount, 0)),
    pendingCount: pending.length,
    matchingEarned,
    goalRemaining,
    goalProgressPercent: child.savingsGoal > 0 ? round2(Math.min(100, balance / child.savingsGoal * 100)) : 0,
    allowanceDue,
  };
}

export function calculateTripPlan(trip: TripPlan, asOf = new Date()) {
  const spent = round2(trip.expenses.reduce((sum, expense) => sum + expense.amount, 0));
  const remainingBudget = round2(trip.budget - spent);
  const fundingGap = round2(Math.max(0, trip.savingsTarget - trip.fundedAmount));
  const start = new Date(`${trip.startDate}T12:00:00Z`);
  const monthsRemaining = Number.isNaN(start.getTime())
    ? 1
    : Math.max(1, Math.ceil((start.getTime() - asOf.getTime()) / (30.4375 * 86_400_000)));
  const requiredMonthlySavings = round2(fundingGap / monthsRemaining);
  const status = trip.endDate < asOf.toISOString().slice(0, 10)
    ? 'complete'
    : trip.startDate <= asOf.toISOString().slice(0, 10)
      ? 'active'
      : 'planning';
  return {
    trip,
    spent,
    remainingBudget,
    fundingGap,
    requiredMonthlySavings,
    planVariance: round2(trip.budget - spent),
    status,
  };
}

export function calculateVehicleTco(input: {
  vehicle: VehicleTcoAsset;
  trailing12FuelCost: number;
  trailing12Miles: number;
  sharedInsurancePremium?: number;
  asOf?: Date;
}) {
  const asOf = input.asOf ?? new Date();
  const purchaseYear = Number(input.vehicle.purchaseDate.slice(0, 4));
  const ageYears = Number.isFinite(purchaseYear)
    ? Math.max(1, asOf.getUTCFullYear() - purchaseYear)
    : 1;
  const annualDepreciation = Math.max(0, (input.vehicle.purchasePrice - input.vehicle.currentValue) / ageYears);
  const insurance = input.vehicle.annualInsurance || input.sharedInsurancePremium || 0;
  const annualOperatingCost = round2(
    input.trailing12FuelCost
      + insurance
      + input.vehicle.annualRegistration
      + input.vehicle.annualMaintenance
      + input.vehicle.annualOther,
  );
  const annualTotalCost = round2(annualOperatingCost + annualDepreciation);
  const monthlyRunRate = round2(annualTotalCost / 12);
  const costPerMile = input.trailing12Miles > 0 ? round2(annualTotalCost / input.trailing12Miles) : 0;
  const horizon = Math.max(1, input.vehicle.repairExtendsYears);
  const keepAndRepairCost = round2(input.vehicle.repairCost + annualOperatingCost * horizon);
  const replaceCost = round2(
    Math.max(0, input.vehicle.replacementVehicleCost - input.vehicle.currentValue)
      + input.vehicle.replacementAnnualOperatingCost * horizon,
  );
  return {
    vehicle: input.vehicle,
    trailing12FuelCost: round2(input.trailing12FuelCost),
    trailing12Miles: round2(input.trailing12Miles),
    insurance: round2(insurance),
    annualDepreciation: round2(annualDepreciation),
    annualOperatingCost,
    annualTotalCost,
    monthlyRunRate,
    costPerMile,
    keepAndRepairCost,
    replaceCost,
    recommendedDecision: keepAndRepairCost <= replaceCost ? 'repair' as const : 'replace' as const,
    decisionSavings: round2(Math.abs(keepAndRepairCost - replaceCost)),
  };
}
