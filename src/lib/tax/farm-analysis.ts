/**
 * Farm formalization analyzer — pure math, no I/O.
 *
 * Compares four ways of handling a home farm's income (built for an NC
 * apiary, parameterized where rules generalize) at the household level:
 *
 * 1. unreported_cash — the informal status quo. Zero incremental tax BY
 *    CONSTRUCTION, shown for comparison only: all income including cash
 *    sales is legally taxable, and this scenario is never recommended.
 *    It also forfeits every farm benefit (the E-595QF sales-tax exemption
 *    and PUV both require farm income evidenced on tax returns).
 * 2. hobby — income reported as other income; expenses NOT deductible
 *    (IRC §183 post-TCJA), but no SE tax and no QBI.
 * 3. schedule_f — sole-proprietor farm: expenses + §179 equipment deductible,
 *    SE tax on net farm profit, QBI, NC qualifying-farmer sales-tax savings.
 * 4. schedule_f_llc — identical taxes (single-member LLC is a disregarded
 *    entity) plus NC LLC fees. The tax identity IS the tool's core insight.
 *
 * MODEL & SIMPLIFICATIONS (documented in MODEL_ASSUMPTIONS for the UI):
 * - Delta-vs-baseline: each scenario's totalCost is the increment over the
 *   household WITHOUT the farm, so other-income tax cancels out.
 * - QBI is the plain 20% computation capped at 20% of taxable income before
 *   QBI; no SSTB phase-out (farming is not an SSTB).
 * - §179 cannot create a farm loss (business income limitation); the clamp
 *   is flagged. Bonus depreciation would reach a similar outcome and is
 *   folded into the assumption notes.
 * - The equipment purchase itself is a cash outlay in EVERY scenario and is
 *   excluded from netAfterTax; only its deductibility differs (via taxes).
 * - Additional Medicare tax (0.9%) and NIIT are not modeled.
 * - LLC fees are modeled as after-tax costs (their own deductibility on
 *   Schedule F is a second-order effect).
 *
 * ESTIMATES ONLY — not tax or legal advice.
 */

import { computeSeTax, getYearStatusParams, taxFromBrackets } from './federal';
import { computeStateTax } from './state';
import type { FilingStatus, TaxYear } from './types';
import {
  CONDITIONAL_FARMER_CERT_YEARS,
  DEFAULT_COMBINED_SALES_TAX_RATE,
  NC_LLC_ANNUAL_REPORT_FEE,
  NC_LLC_FORMATION_FEE,
  PUV,
  QUALIFYING_FARMER_INCOME_THRESHOLD,
} from './nc-farm-rules';

/** Sanity ceiling for the combined sales-tax rate (20%). */
const MAX_SALES_TAX_RATE = 0.2;

const round2 = (n: number) => Math.round(n * 100) / 100;

export const MODEL_ASSUMPTIONS: string[] = [
  'Each scenario is costed as the increment over the household without the farm, so tax on other household income cancels out of every comparison.',
  'Hobby treatment reports the income but deducts nothing: post-2017 the miscellaneous itemized deduction for hobby expenses is suspended. Hobby income is not subject to self-employment tax.',
  'Schedule F nets expenses and §179 equipment expensing against income; §179 cannot create a farm loss (the clamp is flagged when it binds).',
  'QBI is the simple 20% computation capped at 20% of taxable income before QBI. Farming is not a specified service business, so no SSTB phase-out applies.',
  'The single-member LLC is a disregarded entity: its two scenarios differ ONLY by state fees. Multi-member LLCs and S-corp elections are out of scope.',
  'The equipment purchase is the same cash outlay in every scenario and is excluded from net cash; only its deductibility differs.',
  'Additional Medicare tax (0.9%) and NIIT are not modeled — they are nearly identical across scenarios at these income levels.',
  'Sales-tax savings assume the entered annual farm purchases would otherwise all bear the combined rate and all fall in exempt categories.',
  'The §179 business-income limit includes W-2 wages and other active business income (Form 4562 instructions), so equipment expensing can create a farm loss that offsets wages.',
  'Farm book amounts are converted to the book report currency using historical GnuCash prices; the analysis stops when a required rate is missing.',
];

export type FarmScenarioKey = 'unreported_cash' | 'hobby' | 'schedule_f' | 'schedule_f_llc';

export type SalesTaxSavingsBasis = 'qualifying' | 'conditional' | 'none';

export interface FarmAnalysisInput {
  year: TaxYear;
  filingStatus: FilingStatus;
  /** Two-letter state code ('NC'), or null → generic flat-rate fallback. */
  taxState: string | null;
  /** Flat rate override used when taxState is 'OTHER'/null. */
  stateFlatRate?: number | null;
  /** Annualized gross farm income (honey, wax, bees, pollination). */
  grossFarmIncome: number;
  /** Annualized operating expenses, EXCLUDING equipment/capex. */
  farmExpenses: number;
  /** §179-eligible equipment purchases planned this year. */
  plannedEquipmentPurchases: number;
  /** Annual farm purchases that would otherwise bear sales tax. */
  annualTaxableFarmPurchases: number;
  /** Combined state+local sales tax rate (default 0.07 for NC). */
  combinedSalesTaxRate?: number;
  /** Prior-year gross farm income (qualifying-farmer test); null = unknown. */
  priorYearFarmIncome: number | null;
  /** Gross farm income for years -1, -2, and -3 when available. */
  priorThreeYearFarmIncome?: Array<number | null>;
  /** Acres in actual agricultural production (PUV hint); null = skip. */
  acreage: number | null;
  /** First LLC year adds the formation fee on top of the annual report. */
  isFirstLlcYear: boolean;
  /** Household ordinary income outside the farm (W-2, interest...). */
  otherHouseholdOrdinaryIncome: number;
  /** Other household self-employment profit (e.g. spouse's Schedule C). */
  otherHouseholdSeIncome?: number;
  /** Household W-2 SS wages — consume the SS wage base before SE income. */
  otherHouseholdW2Wages?: number;
}

export interface FarmScenarioDetail {
  key: FarmScenarioKey;
  label: string;
  /** False only for unreported_cash — never recommended. */
  compliant: boolean;
  /** Incremental federal income tax vs the no-farm baseline. */
  incomeTax: number;
  /** Incremental SE tax vs the no-farm baseline. */
  seTax: number;
  /** Incremental state income tax vs the no-farm baseline. */
  stateTax: number;
  qbiDeduction: number;
  /** Operating expenses actually deducted in this scenario. */
  deductibleExpenses: number;
  section179Deduction: number;
  /** Estimated sales tax avoided on exempt farm purchases. */
  salesTaxSavings: number;
  /** Recurring entity costs (LLC annual report). */
  recurringCosts: number;
  /** One-time entity costs (LLC formation, first year only). */
  oneTimeCosts: number;
  /**
   * Net incremental cost of the scenario:
   * taxes + entity costs − sales-tax savings. Lower is better.
   */
  totalCost: number;
  /** grossFarmIncome − farmExpenses − totalCost (equipment excluded). */
  netAfterTax: number;
  /** Household taxable income (federal, after deductions) in this scenario. */
  taxableIncome: number;
}

export interface PuvHint {
  eligible: boolean;
  note: string;
}

export interface FarmAnalysisResult {
  scenarios: Record<FarmScenarioKey, FarmScenarioDetail>;
  /** Lowest totalCost among COMPLIANT scenarios — never unreported_cash. */
  best: Exclude<FarmScenarioKey, 'unreported_cash'>;
  /** hobby.totalCost − schedule_f.totalCost (positive = Schedule F saves). */
  scheduleFVsHobby: number;
  /** schedule_f_llc.totalCost − schedule_f.totalCost (≈ the LLC fees). */
  llcVsSoleProp: number;
  /** Cost of moving from unreported cash to the best compliant scenario. */
  costOfCompliance: number;
  qualifiesForSalesTaxExemption: boolean;
  /** Three-preceding-year average, only when all three years are known. */
  priorThreeYearAverage: number | null;
  /** Current-year income clears $10k but prior-year doesn't/unknown. */
  conditionalFarmerPath: boolean;
  salesTaxSavingsBasis: SalesTaxSavingsBasis;
  section179Clamped: boolean;
  puvHint: PuvHint | null;
  warnings: string[];
  assumptions: string[];
}

interface HouseholdTax {
  incomeTax: number;
  seTax: number;
  stateTax: number;
  qbiDeduction: number;
  taxableIncome: number;
}

/**
 * Household federal + SE + state tax with the farm contributing
 * `farmOrdinaryIncome` of ordinary income, of which `farmSeIncome` is
 * subject to SE tax and `qbiBase` is qualified business income.
 */
function householdTax(
  input: FarmAnalysisInput,
  farmOrdinaryIncome: number,
  farmSeIncome: number,
  qbiBase: number,
): HouseholdTax {
  const p = getYearStatusParams(input.year, input.filingStatus);
  const otherSe = Math.max(0, input.otherHouseholdSeIncome ?? 0);
  const otherW2 = Math.max(0, input.otherHouseholdW2Wages ?? 0);

  // Farm losses offset other SE income on Schedule SE; the combined base
  // cannot go below zero.
  const seBase = Math.max(0, otherSe + farmSeIncome);
  const se = computeSeTax(seBase, input.year, otherW2);

  const income = input.otherHouseholdOrdinaryIncome + otherSe + farmOrdinaryIncome;
  const taxableBeforeQbi = Math.max(0, income - se.halfDeduction - p.standardDeduction);
  // QBI base is reduced by the farm-attributable share of the half-SE
  // deduction (proportional split, same convention as s-corp-analysis).
  const farmShare = seBase > 0 ? Math.max(0, farmSeIncome) / seBase : 0;
  const qbiEffectiveBase = Math.max(0, qbiBase - se.halfDeduction * farmShare);
  const qbi = Math.min(0.2 * qbiEffectiveBase, 0.2 * taxableBeforeQbi);
  const taxable = Math.max(0, taxableBeforeQbi - qbi);

  const federalAgi = income - se.halfDeduction;
  const state = computeStateTax(input.taxState ?? 'OTHER', {
    year: input.year,
    filingStatus: input.filingStatus,
    federalAgi: Math.max(0, federalAgi),
    flatRateOverride: input.stateFlatRate ?? undefined,
  });

  return {
    incomeTax: round2(taxFromBrackets(taxable, p.brackets)),
    seTax: se.total,
    stateTax: state.tax,
    qbiDeduction: round2(qbi),
    taxableIncome: round2(taxable),
  };
}

export function analyzeFarmScenarios(input: FarmAnalysisInput): FarmAnalysisResult {
  const gross = Math.max(0, input.grossFarmIncome);
  const expenses = Math.max(0, input.farmExpenses);
  const equipment = Math.max(0, input.plannedEquipmentPurchases);
  const purchases = Math.max(0, input.annualTaxableFarmPurchases);
  const salesTaxRate = Math.min(
    MAX_SALES_TAX_RATE,
    Math.max(0, input.combinedSalesTaxRate ?? DEFAULT_COMBINED_SALES_TAX_RATE),
  );

  const warnings: string[] = [];

  /* ---- Baseline: household without the farm -------------------------- */
  const baseline = householdTax(input, 0, 0, 0);
  const baselineTotal = baseline.incomeTax + baseline.seTax + baseline.stateTax;

  /* ---- Sales-tax exemption gating ------------------------------------ */
  const history = (input.priorThreeYearFarmIncome ?? [
    input.priorYearFarmIncome,
  ]).slice(0, 3);
  while (history.length < 3) history.push(null);
  if (input.priorYearFarmIncome !== null) history[0] = input.priorYearFarmIncome;
  const completeHistory = history.every((value): value is number => value !== null);
  const priorThreeYearAverage = completeHistory
    ? round2(history.reduce((sum, value) => sum + value, 0) / 3)
    : null;
  const qualifiesByPriorYear =
    history[0] !== null && history[0] >= QUALIFYING_FARMER_INCOME_THRESHOLD;
  const qualifiesByThreeYearAverage =
    priorThreeYearAverage !== null &&
    priorThreeYearAverage >= QUALIFYING_FARMER_INCOME_THRESHOLD;
  const qualifies = qualifiesByPriorYear || qualifiesByThreeYearAverage;
  // The conditional certificate (E-595CF) is available on intent to farm —
  // any active farming operation can take this path; the clawback risk is
  // what scales with how far income sits below the threshold.
  const conditionalFarmerPath = !qualifies && gross > 0;
  const salesTaxSavingsBasis: SalesTaxSavingsBasis = qualifies
    ? 'qualifying'
    : conditionalFarmerPath
      ? 'conditional'
      : 'none';
  const salesTaxSavings =
    salesTaxSavingsBasis === 'none' ? 0 : round2(purchases * salesTaxRate);

  /* ---- unreported_cash (never recommended) --------------------------- */
  const unreported: FarmScenarioDetail = {
    key: 'unreported_cash',
    label: 'Unreported cash (not compliant)',
    compliant: false,
    incomeTax: 0,
    seTax: 0,
    stateTax: 0,
    qbiDeduction: 0,
    deductibleExpenses: 0,
    section179Deduction: 0,
    salesTaxSavings: 0,
    recurringCosts: 0,
    oneTimeCosts: 0,
    totalCost: 0,
    netAfterTax: round2(gross - expenses),
    taxableIncome: baseline.taxableIncome,
  };

  /* ---- hobby (reported, no deductions, no SE tax) --------------------- */
  const hobbyTax = householdTax(input, gross, 0, 0);
  const hobbyCost = round2(
    hobbyTax.incomeTax + hobbyTax.seTax + hobbyTax.stateTax - baselineTotal,
  );
  const hobby: FarmScenarioDetail = {
    key: 'hobby',
    label: 'Hobby (reported)',
    compliant: true,
    incomeTax: round2(hobbyTax.incomeTax - baseline.incomeTax),
    seTax: round2(hobbyTax.seTax - baseline.seTax),
    stateTax: round2(hobbyTax.stateTax - baseline.stateTax),
    qbiDeduction: 0,
    deductibleExpenses: 0,
    section179Deduction: 0,
    salesTaxSavings: 0,
    recurringCosts: 0,
    oneTimeCosts: 0,
    totalCost: hobbyCost,
    netAfterTax: round2(gross - expenses - hobbyCost),
    taxableIncome: hobbyTax.taxableIncome,
  };

  /* ---- schedule_f ------------------------------------------------------ */
  // §179 business-income limit: for individuals it aggregates income from
  // ALL actively conducted businesses PLUS W-2 wages (Form 4562
  // instructions), so equipment expensing CAN create a farm loss that
  // offsets wages. Flag when the limit still binds.
  const otherSe = Math.max(0, input.otherHouseholdSeIncome ?? 0);
  const otherW2 = Math.max(0, input.otherHouseholdW2Wages ?? 0);
  const preS179Net = gross - expenses;
  const s179Limit = Math.max(0, preS179Net + otherW2 + otherSe);
  const s179 = Math.min(equipment, s179Limit);
  const section179Clamped = equipment > s179;
  const netFarm = preS179Net - s179;
  // Attribute half-SE proportionally to the farm share for the QBI base.
  const fTax = householdTax(input, netFarm, netFarm, Math.max(0, netFarm));
  const scheduleFCost = round2(
    fTax.incomeTax + fTax.seTax + fTax.stateTax - baselineTotal - salesTaxSavings,
  );
  const scheduleF: FarmScenarioDetail = {
    key: 'schedule_f',
    label: 'Schedule F sole proprietor',
    compliant: true,
    incomeTax: round2(fTax.incomeTax - baseline.incomeTax),
    seTax: round2(fTax.seTax - baseline.seTax),
    stateTax: round2(fTax.stateTax - baseline.stateTax),
    qbiDeduction: fTax.qbiDeduction,
    deductibleExpenses: round2(expenses),
    section179Deduction: round2(s179),
    salesTaxSavings,
    recurringCosts: 0,
    oneTimeCosts: 0,
    totalCost: scheduleFCost,
    netAfterTax: round2(gross - expenses - scheduleFCost),
    taxableIncome: fTax.taxableIncome,
  };

  /* ---- schedule_f_llc (identical taxes + NC fees) ---------------------- */
  const recurringCosts = NC_LLC_ANNUAL_REPORT_FEE;
  const oneTimeCosts = input.isFirstLlcYear ? NC_LLC_FORMATION_FEE : 0;
  const llcCost = round2(scheduleFCost + recurringCosts + oneTimeCosts);
  const scheduleFLlc: FarmScenarioDetail = {
    ...scheduleF,
    key: 'schedule_f_llc',
    label: 'Schedule F + NC LLC',
    recurringCosts,
    oneTimeCosts,
    totalCost: llcCost,
    netAfterTax: round2(gross - expenses - llcCost),
  };

  /* ---- Verdict --------------------------------------------------------- */
  const compliantScenarios = [hobby, scheduleF, scheduleFLlc] as const;
  const best = compliantScenarios.reduce((a, b) =>
    b.totalCost < a.totalCost ? b : a,
  ).key as FarmAnalysisResult['best'];

  /* ---- Warnings -------------------------------------------------------- */
  warnings.push(
    'All income — including cash sales — is legally required to be reported. The unreported-cash column is shown only to quantify the cost of coming into compliance; penalties for unreported income include failure-to-pay, 20% accuracy-related, and 75% civil fraud penalties, with no statute of limitations on fraud.',
  );
  if (salesTaxSavingsBasis !== 'none' || gross > 0) {
    warnings.push(
      'Unreported income cannot establish qualifying-farmer status: the E-595QF exemption and present-use value both require farm income evidenced on tax returns.',
    );
  }
  if (netFarm <= 0 && (expenses > 0 || equipment > 0)) {
    warnings.push(
      'The farm shows no net profit under Schedule F. Sustained losses invite hobby-loss (IRC §183) scrutiny — the safe harbor presumes profit motive when the activity is profitable in 3 of 5 consecutive years. Heavy §179/bonus write-offs that manufacture losses heighten this tension.',
    );
  }
  if (section179Clamped) {
    warnings.push(
      `§179 expensing was limited to ${formatUsd(s179)} of the ${formatUsd(equipment)} planned equipment purchase — the deduction cannot exceed total business income (farm profit plus wages and other business income). The remainder would carry forward (or use bonus depreciation, which has no such limit; not modeled).`,
    );
  }
  if (salesTaxSavingsBasis === 'conditional') {
    warnings.push(
      `Prior-year farm income is below the $${QUALIFYING_FARMER_INCOME_THRESHOLD.toLocaleString()} qualifying-farmer threshold, so sales-tax savings assume a CONDITIONAL farmer certificate (E-595CF): ${CONDITIONAL_FARMER_CERT_YEARS} years, non-renewable, and if the threshold is never met all exempted taxes are clawed back with interest.${
        gross < QUALIFYING_FARMER_INCOME_THRESHOLD
          ? ' Current-year farm income is ALSO below the threshold — the clawback risk is real unless income grows.'
          : ''
      }`,
    );
  }
  if (qualifiesByThreeYearAverage && !qualifiesByPriorYear) {
    warnings.push(
      `The immediately preceding year is below $${QUALIFYING_FARMER_INCOME_THRESHOLD.toLocaleString()}, but the three-preceding-year average is ${formatUsd(priorThreeYearAverage!)}; the average test qualifies under N.C. G.S. 105-164.13E.`,
    );
  }
  if (!completeHistory) {
    warnings.push(
      'A complete three-preceding-year farm-income history is not available, so the NC average-income qualification test could not be fully evaluated.',
    );
  }
  if (salesTaxSavingsBasis === 'none' && purchases > 0) {
    warnings.push(
      `No farming income is entered — no sales-tax savings are counted (the E-595QF/E-595CF certificates require an active farming operation).`,
    );
  }
  const householdTotal =
    gross + input.otherHouseholdOrdinaryIncome + otherSe;
  if (householdTotal > 0 && gross >= (2 / 3) * householdTotal) {
    warnings.push(
      'At least two-thirds of household gross income is from farming: you may skip quarterly estimates entirely by filing and paying by March 1, or make a single estimated payment by January 15.',
    );
  }
  // Only accurate when the farm is the household's ONLY SE income — with
  // other Schedule C/SE income the combined Schedule SE base already exceeds
  // the floor and farm dollars are taxed from the first dollar.
  if (gross > 0 && netFarm > 0 && netFarm * 0.9235 < 400 && otherSe === 0) {
    warnings.push(
      'Net farm earnings are under $400 — no self-employment tax is due at this level.',
    );
  }

  /* ---- PUV hint -------------------------------------------------------- */
  let puvHint: PuvHint | null = null;
  if (input.acreage !== null && input.acreage !== undefined) {
    const eligible = input.acreage >= PUV.agAcres && gross >= PUV.avgIncomeMin;
    puvHint = {
      eligible,
      note: eligible
        ? `With ${input.acreage} acres in production and farm income above $${PUV.avgIncomeMin.toLocaleString()}, the land may qualify for present-use value property taxation (honey income counts since July 2023). Disqualification triggers a 3-year rollback plus interest.`
        : `Present-use value needs ${PUV.agAcres}+ acres in actual agricultural production (${PUV.hortAcres}+ horticultural) and a $${PUV.avgIncomeMin.toLocaleString()} 3-year average gross income. Hives alone rarely satisfy the acreage test.`,
    };
  }

  return {
    scenarios: {
      unreported_cash: unreported,
      hobby,
      schedule_f: scheduleF,
      schedule_f_llc: scheduleFLlc,
    },
    best,
    scheduleFVsHobby: round2(hobby.totalCost - scheduleF.totalCost),
    llcVsSoleProp: round2(scheduleFLlc.totalCost - scheduleF.totalCost),
    costOfCompliance: round2(
      Math.min(hobby.totalCost, scheduleF.totalCost, scheduleFLlc.totalCost),
    ),
    qualifiesForSalesTaxExemption: qualifies,
    priorThreeYearAverage,
    conditionalFarmerPath,
    salesTaxSavingsBasis,
    section179Clamped,
    puvHint,
    warnings,
    assumptions: MODEL_ASSUMPTIONS,
  };
}

function formatUsd(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}
