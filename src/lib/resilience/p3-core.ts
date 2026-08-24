import type {
  EducationChild,
  FamilyBankChild,
  TripPlan,
  UtilitiesProfile,
  UtilityBill,
  UtilityCharge,
  UtilityChargeCategory,
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

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function isoDate(month: string, day: string, year: string): string | null {
  const m = MONTHS[month.slice(0, 3).toLowerCase()];
  const d = Number(day);
  if (!m || !Number.isFinite(d) || d < 1 || d > 31) return null;
  // Bills abbreviate the year ("Nov 06 24"), and these are utility statements,
  // so a 2-digit year is always 20xx.
  const y = year.length === 2 ? 2000 + Number(year) : Number(year);
  if (!Number.isFinite(y) || y < 1900 || y > 2200) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Service period, preferred over any date the app knows about: a bill uploaded
 * today can be years old, and the usage belongs to the period it was metered,
 * not to the upload.
 */
export function parseUtilityBillPeriod(text: string): { start: string | null; end: string | null } {
  // "Billing Period - Oct 05 24 to Nov 06 24" — the only form carrying both
  // endpoints AND their years, so it wins when present.
  const explicit = text.match(
    /billing period\s*[-–—]?\s*([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})\s*(?:to|-|–|through)\s*([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})/i,
  );
  if (explicit) {
    const start = isoDate(explicit[1], explicit[2], explicit[3]);
    const end = isoDate(explicit[4], explicit[5], explicit[6]);
    if (start && end) return { start, end };
  }

  // "Service period 10/05/2024 - 11/06/2024"
  const numeric = text.match(
    /(?:billing|service)\s*period\s*[:-]?\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*(?:to|-|–|through)\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i,
  );
  if (numeric) {
    const start = isoDate(Object.keys(MONTHS)[Number(numeric[1]) - 1] ?? '', numeric[2], numeric[3]);
    const end = isoDate(Object.keys(MONTHS)[Number(numeric[4]) - 1] ?? '', numeric[5], numeric[6]);
    if (start && end) return { start, end };
  }

  // "Bill date  Account number Nov 8, 2024" — the label and the value are
  // separated by other columns once OCR flattens the page, hence the gap.
  const billDate = text.match(/bill date\b[^\n]{0,80}?\b([a-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})/i);
  if (billDate) {
    const end = isoDate(billDate[1], billDate[2], billDate[3]);
    if (end) return { start: null, end };
  }

  return { start: null, end: null };
}

/** Section headers and column labels that must never be read as charge names. */
const NON_CHARGE_LABEL = /billing period|meter|account number|page \d|previous|payment received|amount enclosed|reading on|balance/i;
const TOTAL_LABEL = /^total\b|^\|?\s*total\b|total (?:current )?(?:charges|taxes|amount)/i;
const TAX_LABEL = /tax/i;
const SUPPLY_LABEL = /energy charge|electric(?:ity)? charge|gas charge|water (?:usage|charge)|supply|generation|commodity|consumption charge/i;

/**
 * Itemized charges from the bill's detail section.
 *
 * Only the region from the first "Billing details" heading onward is scanned:
 * the summary earlier in the bill mixes in the previous balance and payments,
 * which are not charges for this period. Labels may not contain digits, which
 * keeps meter numbers and period dates out of them.
 */
export function parseUtilityCharges(text: string): UtilityCharge[] {
  // Split on the section headings and categorize by section, not by label
  // alone: "Power Manager - Thermostat" reads like a fee but sits under
  // "Products and Services", and a rebate booked as a fee would drag cost per
  // unit down and show up as a rate change that never happened.
  const bodies: string[] = [];
  const headingRe = /billing details\s*[-–—]?\s*/gi;
  let heading: RegExpExecArray | null;
  let previousStart: number | null = null;
  while ((heading = headingRe.exec(text)) !== null) {
    if (previousStart !== null) bodies.push(text.slice(previousStart, heading.index));
    previousStart = heading.index + heading[0].length;
  }
  if (previousStart === null) return [];
  bodies.push(text.slice(previousStart));

  return bodies.flatMap(raw => {
    const { name, body } = splitSectionName(raw);
    const sectionCategory: UtilityChargeCategory | null = /tax/i.test(name)
      ? 'tax'
      : /products?\b|merchandise|service charge/i.test(name)
        ? 'other'
        : null;
    return parseChargeLines(body, sectionCategory);
  });
}

/**
 * Section names are not delimited from the first charge label once OCR
 * flattens the page ("Taxes  Sales Tax For Utility   $10.93"), so they have to
 * be consumed by name or they end up prefixed onto that label.
 */
const SECTION_NAME = /^(products and services|other charges|electricity|electric|natural gas|gas|water|sewer|taxes|tax|charges)\b\s*/i;

function splitSectionName(raw: string): { name: string; body: string } {
  const trimmed = raw.replace(/^[\s|.-]+/, '');
  const known = SECTION_NAME.exec(trimmed);
  if (known) return { name: known[1], body: trimmed.slice(known[0].length) };
  // Unknown section: drop its first word so the label does not inherit it.
  const firstWord = /^([A-Za-z]+)\s+/.exec(trimmed);
  return firstWord
    ? { name: firstWord[1], body: trimmed.slice(firstWord[0].length) }
    : { name: trimmed.slice(0, 40), body: trimmed };
}

function parseChargeLines(region: string, sectionCategory: UtilityChargeCategory | null): UtilityCharge[] {
  const charges: UtilityCharge[] = [];
  // The sign is captured: credits appear as "$-2.38" and "-1.00" (a rebate's
  // tax reversal, say), and dropping the minus silently overstates the bill.
  const re = /([A-Za-z][A-Za-z .'&\/-]{2,60}?)\s+(?:[\d,]+(?:\.\d+)?\s*(?:kwh|therms?|gallons?|gal|ccf|units?)\s*@\s*\$?-?[\d.]+\s+)?(?:\$\s*)?(-)?(?:\$\s*)?([\d,]+\.\d{2})(?!\d)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(region)) !== null) {
    const label = match[1].replace(/^[\s|.-]+/, '').trim();
    const amount = Number(match[3].replaceAll(',', '')) * (match[2] ? -1 : 1);
    if (!label || !Number.isFinite(amount)) continue;
    if (NON_CHARGE_LABEL.test(label)) continue;
    // Totals are derived, not line items — keeping them would double-count.
    if (TOTAL_LABEL.test(label)) continue;
    charges.push({
      label,
      amount,
      category: sectionCategory
        ?? (TAX_LABEL.test(label) ? 'tax' : SUPPLY_LABEL.test(label) ? 'supply' : 'fee'),
    });
  }
  return charges;
}

/**
 * Municipal water bills print a meter TABLE instead of prose — no
 * "N gallons" phrase anywhere, so `parseUsage` cannot see them. Once OCR
 * flattens the columns the row reads:
 *
 *   "WATER   39.81 35 202300   207200   4900"
 *    service amount days previous present consumption
 *
 * The column mapping is confirmed by the meter invariant
 * `present − previous = consumption`; a row that fails it is ignored rather
 * than guessed at. The row's amount is this period's cost of service —
 * deliberately not "TOTAL DUE", which carries any unpaid prior balance.
 * The service period is recovered by finding the pair of printed dates
 * exactly `days` apart.
 */
export function parseMunicipalWaterBill(text: string): {
  amount: number;
  days: number;
  usage: number;
  periodStart: string | null;
  periodEnd: string | null;
} | null {
  const rowRe = /\bWATER\b\s+([\d,]+\.\d{2})\s+(\d{1,3})\s+([\d,]{2,12})\s+([\d,]{2,12})\s+([\d,]{1,10})\b/gi;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(text)) !== null) {
    const amount = Number(row[1].replaceAll(',', ''));
    const days = Number(row[2]);
    const previous = Number(row[3].replaceAll(',', ''));
    const present = Number(row[4].replaceAll(',', ''));
    const consumption = Number(row[5].replaceAll(',', ''));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (!Number.isFinite(consumption) || consumption <= 0) continue;
    if (present - previous !== consumption) continue;

    // Service period: the printed date pair exactly `days` apart (billing
    // date and period start sit next to each other on these bills).
    let periodStart: string | null = null;
    let periodEnd: string | null = null;
    const dates = [...text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)]
      .map(m => new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]))))
      .filter(d => !Number.isNaN(d.getTime()));
    outer: for (const a of dates) {
      for (const b of dates) {
        if ((b.getTime() - a.getTime()) / 86400000 === days) {
          periodStart = a.toISOString().slice(0, 10);
          periodEnd = b.toISOString().slice(0, 10);
          break outer;
        }
      }
    }

    return { amount, days, usage: consumption, periodStart, periodEnd };
  }
  return null;
}

function parseUsage(text: string): { usage: number; unit: string } | null {
  const patterns = [
    /energy used\s*[:\s]\s*([\d,]+(?:\.\d+)?)\s*(kwh|therms?|gallons?|gal|ccf)\b/i,
    /billed\s+(kwh|therms?|gallons?|gal|ccf)\s*[:\s]\s*([\d,]+(?:\.\d+)?)/i,
    /total (?:usage|consumption)\s*[:\s]\s*([\d,]+(?:\.\d+)?)\s*(kwh|therms?|gallons?|gal|ccf)\b/i,
    /([\d,]+(?:\.\d+)?)\s*(kwh|therms?|gallons?|gal|ccf)\b/i,
  ];
  for (const [index, pattern] of patterns.entries()) {
    const match = text.match(pattern);
    if (!match) continue;
    // The "Billed kWh" form puts the unit before the number.
    const [rawUsage, rawUnit] = index === 1 ? [match[2], match[1]] : [match[1], match[2]];
    const usage = Number(rawUsage.replaceAll(',', ''));
    if (Number.isFinite(usage) && usage > 0) return { usage, unit: rawUnit.toLowerCase() };
  }
  return null;
}

export function parseUtilityBillText(input: {
  receiptId: number;
  date: string;
  provider: string;
  text: string;
}): UtilityBill | null {
  const parsedUsage = parseUsage(input.text);
  if (!parsedUsage) {
    // Prose patterns found nothing — try the municipal meter-table layout.
    const municipal = parseMunicipalWaterBill(input.text);
    if (!municipal) return null;
    return {
      id: `receipt-${input.receiptId}-water`,
      date: (municipal.periodEnd ?? input.date).slice(0, 10),
      type: 'water',
      provider: input.provider,
      usage: municipal.usage,
      unit: 'gallons',
      totalCost: municipal.amount,
      periodStart: municipal.periodStart,
      periodEnd: municipal.periodEnd,
      charges: [{ label: 'Water service', amount: municipal.amount, category: 'supply' }],
      supplyCost: municipal.amount,
      feeCost: 0,
      taxCost: 0,
      otherCost: 0,
      transactionGuid: null,
      receiptId: input.receiptId,
    };
  }

  const charges = parseUtilityCharges(input.text);
  const sumOf = (category: UtilityChargeCategory) =>
    round2(charges.filter(charge => charge.category === category).reduce((sum, c) => sum + c.amount, 0));
  const supplyCost = sumOf('supply');
  const feeCost = sumOf('fee');
  const taxCost = sumOf('tax');
  const otherCost = sumOf('other');

  // Prefer the itemized charges: they are exactly this period's cost of
  // service. "Total Amount Due" is deliberately NOT the first choice — it also
  // carries any unpaid prior balance and unrelated credits (an appliance rebate
  // posted to the electric bill, say), which would distort cost per unit.
  //
  // The fallback matches "Total Amount Due" explicitly and tolerates the due
  // date that sits between the label and the figure ("Total Amount Due Dec 03
  // $167.12"); an unanchored search would otherwise settle on "Previous Amount
  // Due" and import last month's total.
  let totalCost = round2(supplyCost + feeCost + taxCost);
  if (totalCost <= 0) {
    const stated = input.text.match(/total amount due\b[^$]{0,40}\$\s*([\d,]+\.\d{2})/i)
      ?? input.text.match(/(?:amount due|total due|new charges)\b[^$]{0,40}\$\s*([\d,]+\.\d{2})/i);
    totalCost = stated ? Number(stated[1].replaceAll(',', '')) : 0;
  }
  if (!Number.isFinite(totalCost) || totalCost <= 0) return null;

  const rawUnit = parsedUsage.unit;
  const type: UtilityType = rawUnit === 'kwh'
    ? 'electric'
    : rawUnit.startsWith('therm') || rawUnit === 'ccf' ? 'gas' : 'water';
  const unit: UtilityBill['unit'] = type === 'electric' ? 'kWh' : type === 'gas' ? 'therms' : 'gallons';

  const period = parseUtilityBillPeriod(input.text);
  return {
    id: `receipt-${input.receiptId}-${type}`,
    date: (period.end ?? input.date).slice(0, 10),
    type,
    provider: input.provider,
    usage: parsedUsage.usage,
    unit,
    totalCost,
    periodStart: period.start,
    periodEnd: period.end,
    charges,
    supplyCost,
    feeCost,
    taxCost,
    otherCost,
    transactionGuid: null,
    receiptId: input.receiptId,
  };
}

/**
 * Identity of a bill for duplicate detection: the same service period (or bill
 * date), utility type, metered usage, and total. Two receipts that parse to the
 * same key are the same paper bill — uploaded twice, or re-uploaded after an
 * earlier import.
 */
export function utilityBillMatchKey(bill: Pick<UtilityBill, 'type' | 'date' | 'periodEnd' | 'usage' | 'totalCost'>): string {
  return [bill.type, bill.periodEnd ?? bill.date, round2(bill.usage), round2(bill.totalCost)].join('|');
}

/**
 * Collapse suggestions that parsed to the same bill. The first occurrence in
 * list order wins (the caller orders by transaction/upload date descending);
 * the shadowed receipts simply stay unlinked evidence.
 */
export function dedupeUtilityBillSuggestions<T extends UtilityBill>(suggestions: T[]): T[] {
  const seen = new Set<string>();
  return suggestions.filter(suggestion => {
    const key = utilityBillMatchKey(suggestion);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A bill already in the profile that matches the candidate — a re-upload of
 * something previously imported (possibly from a different receipt, so the
 * receipt-id filter cannot catch it).
 */
export function findDuplicateUtilityBill(
  candidate: Pick<UtilityBill, 'id' | 'type' | 'date' | 'periodEnd' | 'usage' | 'totalCost'>,
  bills: UtilityBill[],
): UtilityBill | null {
  const key = utilityBillMatchKey(candidate);
  return bills.find(bill => bill.id !== candidate.id && utilityBillMatchKey(bill) === key) ?? null;
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
