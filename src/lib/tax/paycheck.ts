/**
 * Paycheck / offer modeler — pure functions, no I/O.
 *
 * Builds a gross-to-net waterfall for a single W-2 job using the federal
 * engine (federal.ts) and the pluggable state modules (state/index.ts):
 *
 *   gross
 *     - traditional 401(k) elective deferral   (pre federal/state, FICA-taxed)
 *     - HSA / FSA payroll contributions        (cafeteria plan: pre-FICA too)
 *     - health premium                         (cafeteria plan: pre-FICA too)
 *     - federal income tax
 *     - Social Security + Medicare
 *     - state income tax
 *   = net
 *
 * Assumes the standard deduction, no other income, and no credits — this is
 * a take-home-pay model, not a full return. ESTIMATES ONLY — not tax advice.
 */

import {
  computeFederalTax,
  emptyFederalInputs,
  getSsWageBase,
  getYearStatusParams,
} from './federal';
import { computeStateTax } from './state';
import type { FederalTaxResult, FilingStatus, StateTaxResult, TaxYear } from './types';

export const PAY_FREQUENCIES = [
  { periodsPerYear: 52, label: 'Weekly' },
  { periodsPerYear: 26, label: 'Biweekly' },
  { periodsPerYear: 24, label: 'Semi-monthly' },
  { periodsPerYear: 12, label: 'Monthly' },
] as const;

const SS_RATE = 0.062;
const MEDICARE_RATE = 0.0145;
const ADDL_MEDICARE_RATE = 0.009;

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface PaycheckInputs {
  year: TaxYear;
  filingStatus: FilingStatus;
  /** State module code ('NC', 'CA', 'OTHER', ...) */
  stateCode: string;
  /** Flat-rate override for the 'OTHER' state module (decimal). */
  stateFlatRate?: number;
  /** Pay periods per year: 52, 26, 24, or 12. */
  payPeriodsPerYear: number;
  /** Annual gross salary (resolve hourly x hours upstream). */
  annualGross: number;
  /** Traditional 401(k) elective deferral as a percent of gross (0-100). */
  trad401kPercent: number;
  /** HSA payroll contribution per paycheck (cafeteria plan). */
  hsaPerPaycheck: number;
  /** FSA payroll contribution per paycheck (cafeteria plan). */
  fsaPerPaycheck: number;
  /** Pre-tax health/dental/vision premium per paycheck (cafeteria plan). */
  healthPremiumPerPaycheck: number;
}

export interface PaycheckLine {
  gross: number;
  contrib401k: number;
  hsa: number;
  fsa: number;
  healthPremium: number;
  federalTax: number;
  socialSecurity: number;
  medicare: number;
  stateTax: number;
  net: number;
}

export interface PaycheckResult {
  annual: PaycheckLine;
  perPaycheck: PaycheckLine;
  payPeriodsPerYear: number;
  /** W-2 box 1 wages after 401(k) + cafeteria exclusions. */
  taxableWages: number;
  /** FICA wage base after cafeteria exclusions (401k still FICA-taxed). */
  ficaWages: number;
  federalMarginalRate: number;
  stateMarginalRate: number;
  /** Federal + state marginal on the next dollar of ordinary income. */
  combinedMarginalRate: number;
  /** All tax (federal + FICA + state) / gross. */
  effectiveTaxRate: number;
  federal: FederalTaxResult;
  state: StateTaxResult;
}

/** Scale an annual waterfall line down to one paycheck. */
function scaleLine(line: PaycheckLine, periods: number): PaycheckLine {
  const out = {} as PaycheckLine;
  for (const key of Object.keys(line) as Array<keyof PaycheckLine>) {
    out[key] = round2(line[key] / periods);
  }
  return out;
}

export function computePaycheck(inputs: PaycheckInputs): PaycheckResult {
  const periods = inputs.payPeriodsPerYear > 0 ? inputs.payPeriodsPerYear : 26;
  const gross = Math.max(0, inputs.annualGross);

  const contrib401k = gross * Math.min(100, Math.max(0, inputs.trad401kPercent)) / 100;
  const hsa = Math.max(0, inputs.hsaPerPaycheck) * periods;
  const fsa = Math.max(0, inputs.fsaPerPaycheck) * periods;
  const premium = Math.max(0, inputs.healthPremiumPerPaycheck) * periods;
  const cafeteria = hsa + fsa + premium;

  // Elective 401(k) deferrals are excluded from box 1 wages but remain
  // subject to FICA; cafeteria-plan items (HSA/FSA/premiums) escape both.
  const taxableWages = Math.max(0, gross - contrib401k - cafeteria);
  const ficaWages = Math.max(0, gross - cafeteria);

  // Payroll deferrals are already excluded from `wages`, so no adjustment
  // inputs are passed — passing them too would double-deduct.
  const federal = computeFederalTax({
    ...emptyFederalInputs(inputs.year, inputs.filingStatus),
    wages: taxableWages,
  });
  // The engine's Additional Medicare is based on box-1 wages; the paycheck
  // model computes all FICA itself on the (higher) FICA wage base.
  const federalTax = Math.max(0, federal.totalTax - federal.additionalMedicareTax);

  const ssWageBase = getSsWageBase(inputs.year);
  const addlMedicareThreshold = getYearStatusParams(inputs.year, inputs.filingStatus).niitThreshold;
  const socialSecurity = SS_RATE * Math.min(ficaWages, ssWageBase);
  const medicare =
    MEDICARE_RATE * ficaWages +
    ADDL_MEDICARE_RATE * Math.max(0, ficaWages - addlMedicareThreshold);

  const state = computeStateTax(inputs.stateCode, {
    year: inputs.year,
    filingStatus: inputs.filingStatus,
    federalAgi: federal.agi,
    flatRateOverride: inputs.stateFlatRate,
  });

  const net =
    gross - contrib401k - cafeteria - federalTax - socialSecurity - medicare - state.tax;

  const annual: PaycheckLine = {
    gross: round2(gross),
    contrib401k: round2(contrib401k),
    hsa: round2(hsa),
    fsa: round2(fsa),
    healthPremium: round2(premium),
    federalTax: round2(federalTax),
    socialSecurity: round2(socialSecurity),
    medicare: round2(medicare),
    stateTax: round2(state.tax),
    net: round2(net),
  };

  const totalTax = federalTax + socialSecurity + medicare + state.tax;

  return {
    annual,
    perPaycheck: scaleLine(annual, periods),
    payPeriodsPerYear: periods,
    taxableWages: round2(taxableWages),
    ficaWages: round2(ficaWages),
    federalMarginalRate: federal.marginalRate,
    stateMarginalRate: state.marginalRate,
    combinedMarginalRate: Math.round((federal.marginalRate + state.marginalRate) * 10000) / 10000,
    effectiveTaxRate: gross > 0 ? Math.round((totalTax / gross) * 10000) / 10000 : 0,
    federal,
    state,
  };
}
