/**
 * State tax module framework — pluggable, pure functions.
 *
 * Implements:
 * - No-income-tax states: TX, FL, WA, NV, TN, SD, WY, AK, NH
 * - Flat-rate states: CO, IL, PA, MI, IN, UT, NC, KY, AZ, GA
 * - Bracketed: CA, NY
 * - Generic fallback ("OTHER") using a user-supplied flat rate override
 *
 * Rates verified June 2026 against Tax Foundation state individual income
 * tax rate tables (2025 and 2026 editions). State taxable income is
 * approximated as federal AGI minus the state standard deduction — state
 * credits, exemptions, and add-backs are NOT modeled. Estimates only.
 */

import type { FilingStatus, StateTaxInputs, StateTaxResult, TaxYear } from '../types';

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface StateTaxModule {
  code: string;
  name: string;
  compute(inputs: StateTaxInputs): StateTaxResult;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function noTaxModule(code: string, name: string, note?: string): StateTaxModule {
  return {
    code,
    name,
    compute: () => ({
      stateCode: code,
      stateName: name,
      method: 'none',
      taxableIncome: 0,
      tax: 0,
      effectiveRate: 0,
      marginalRate: 0,
      notes: note ? [note] : [`${name} has no state income tax.`],
    }),
  };
}

function flatModule(
  code: string,
  name: string,
  ratesByYear: Record<TaxYear, number>,
  standardDeduction: number = 0,
): StateTaxModule {
  return {
    code,
    name,
    compute: (inputs) => {
      const rate = ratesByYear[inputs.year];
      const taxable = Math.max(0, inputs.federalAgi - standardDeduction);
      const tax = taxable * rate;
      return {
        stateCode: code,
        stateName: name,
        method: 'flat',
        taxableIncome: round2(taxable),
        tax: round2(tax),
        effectiveRate: inputs.federalAgi > 0 ? round2((tax / inputs.federalAgi) * 10000) / 10000 : 0,
        marginalRate: rate,
        notes: [`Flat ${(rate * 100).toFixed(2)}% on taxable income.`],
      };
    },
  };
}

interface StateBracket {
  rate: number;
  upTo: number; // Infinity for top
}

function taxFromStateBrackets(amount: number, brackets: StateBracket[]): { tax: number; marginal: number } {
  let tax = 0;
  let prev = 0;
  let marginal = 0;
  for (const b of brackets) {
    if (amount <= prev) break;
    const inBracket = Math.min(amount, b.upTo) - prev;
    tax += inBracket * b.rate;
    marginal = b.rate;
    prev = b.upTo;
  }
  return { tax, marginal };
}

const INF = Infinity;

/* ------------------------------------------------------------------ */
/* California (bracketed)                                              */
/* ------------------------------------------------------------------ */

// Single/MFS schedule (Tax Foundation 2026 table; CA indexes annually).
// MFJ/QSS thresholds are double; HOH approximated with the single schedule.
const CA_SINGLE: StateBracket[] = [
  { rate: 0.01, upTo: 11_079 },
  { rate: 0.02, upTo: 26_264 },
  { rate: 0.04, upTo: 41_452 },
  { rate: 0.06, upTo: 57_542 },
  { rate: 0.08, upTo: 72_724 },
  { rate: 0.093, upTo: 371_479 },
  { rate: 0.103, upTo: 445_771 },
  { rate: 0.113, upTo: 742_953 },
  { rate: 0.123, upTo: INF },
];

const CA_STD_DED: Record<'single' | 'joint', number> = { single: 5_540, joint: 11_080 };

const californiaModule: StateTaxModule = {
  code: 'CA',
  name: 'California',
  compute: (inputs) => {
    const joint = inputs.filingStatus === 'mfj' || inputs.filingStatus === 'qss';
    const stdDed = joint ? CA_STD_DED.joint : CA_STD_DED.single;
    const brackets = joint
      ? CA_SINGLE.map(b => ({ rate: b.rate, upTo: b.upTo === INF ? INF : b.upTo * 2 }))
      : CA_SINGLE;
    const taxable = Math.max(0, inputs.federalAgi - stdDed);
    const { tax: baseTax, marginal } = taxFromStateBrackets(taxable, brackets);
    // 1% Mental Health Services Tax on taxable income over $1M
    const mhst = Math.max(0, taxable - 1_000_000) * 0.01;
    const tax = baseTax + mhst;
    const notes = [
      'California progressive brackets (capital gains taxed as ordinary income).',
    ];
    if (mhst > 0) notes.push('Includes 1% Mental Health Services Tax on income over $1M.');
    if (inputs.filingStatus === 'hoh') notes.push('Head-of-household approximated with the single schedule.');
    return {
      stateCode: 'CA',
      stateName: 'California',
      method: 'brackets',
      taxableIncome: round2(taxable),
      tax: round2(tax),
      effectiveRate: inputs.federalAgi > 0 ? round2((tax / inputs.federalAgi) * 10000) / 10000 : 0,
      marginalRate: taxable > 1_000_000 ? marginal + 0.01 : marginal,
      notes,
    };
  },
};

/* ------------------------------------------------------------------ */
/* New York (bracketed)                                                */
/* ------------------------------------------------------------------ */

// 2024/2025 schedule; 2026 reflects the middle-class rate cuts
// (3.90/4.40/5.15/5.40/5.90 on the lower brackets per Tax Foundation 2026).
const NY_SINGLE_2025: StateBracket[] = [
  { rate: 0.040, upTo: 8_500 },
  { rate: 0.045, upTo: 11_700 },
  { rate: 0.0525, upTo: 13_900 },
  { rate: 0.055, upTo: 80_650 },
  { rate: 0.060, upTo: 215_400 },
  { rate: 0.0685, upTo: 1_077_550 },
  { rate: 0.0965, upTo: 5_000_000 },
  { rate: 0.103, upTo: 25_000_000 },
  { rate: 0.109, upTo: INF },
];

const NY_SINGLE_2026: StateBracket[] = [
  { rate: 0.039, upTo: 8_500 },
  { rate: 0.044, upTo: 11_700 },
  { rate: 0.0515, upTo: 13_900 },
  { rate: 0.054, upTo: 80_650 },
  { rate: 0.059, upTo: 215_400 },
  { rate: 0.0685, upTo: 1_077_550 },
  { rate: 0.0965, upTo: 5_000_000 },
  { rate: 0.103, upTo: 25_000_000 },
  { rate: 0.109, upTo: INF },
];

const NY_MFJ_UPTO = [17_150, 23_600, 27_900, 161_550, 323_200, 2_155_350, 5_000_000, 25_000_000, INF];

function nyBrackets(year: TaxYear, filingStatus: FilingStatus): StateBracket[] {
  const single = year >= 2026 ? NY_SINGLE_2026 : NY_SINGLE_2025;
  if (filingStatus === 'mfj' || filingStatus === 'qss') {
    return single.map((b, i) => ({ rate: b.rate, upTo: NY_MFJ_UPTO[i] }));
  }
  return single;
}

const NY_STD_DED: Record<FilingStatus, number> = {
  single: 8_000,
  mfj: 16_050,
  qss: 16_050,
  mfs: 8_000,
  hoh: 11_200,
};

const newYorkModule: StateTaxModule = {
  code: 'NY',
  name: 'New York',
  compute: (inputs) => {
    const stdDed = NY_STD_DED[inputs.filingStatus];
    const taxable = Math.max(0, inputs.federalAgi - stdDed);
    const { tax, marginal } = taxFromStateBrackets(taxable, nyBrackets(inputs.year, inputs.filingStatus));
    return {
      stateCode: 'NY',
      stateName: 'New York',
      method: 'brackets',
      taxableIncome: round2(taxable),
      tax: round2(tax),
      effectiveRate: inputs.federalAgi > 0 ? round2((tax / inputs.federalAgi) * 10000) / 10000 : 0,
      marginalRate: marginal,
      notes: [
        'New York progressive brackets. Supplemental tax recapture for high incomes not modeled.',
        ...(inputs.year >= 2026 ? ['Reflects 2026 middle-class rate reductions.'] : []),
      ],
    };
  },
};

/* ------------------------------------------------------------------ */
/* Generic fallback (user flat-rate override)                          */
/* ------------------------------------------------------------------ */

const genericModule: StateTaxModule = {
  code: 'OTHER',
  name: 'Other (flat rate override)',
  compute: (inputs) => {
    const rate = Math.max(0, inputs.flatRateOverride ?? 0);
    const taxable = Math.max(0, inputs.federalAgi);
    const tax = taxable * rate;
    return {
      stateCode: 'OTHER',
      stateName: 'Other',
      method: 'flat_override',
      taxableIncome: round2(taxable),
      tax: round2(tax),
      effectiveRate: inputs.federalAgi > 0 ? round2((tax / inputs.federalAgi) * 10000) / 10000 : 0,
      marginalRate: rate,
      notes: [
        rate > 0
          ? `User-entered flat rate of ${(rate * 100).toFixed(2)}% applied to federal AGI.`
          : 'Enter a flat rate to estimate state tax for this state.',
      ],
    };
  },
};

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export const STATE_MODULES: Record<string, StateTaxModule> = {
  // No income tax
  TX: noTaxModule('TX', 'Texas'),
  FL: noTaxModule('FL', 'Florida'),
  WA: noTaxModule('WA', 'Washington', 'Washington has no wage income tax. Its 7% capital gains excise tax on large gains is not modeled.'),
  NV: noTaxModule('NV', 'Nevada'),
  TN: noTaxModule('TN', 'Tennessee'),
  SD: noTaxModule('SD', 'South Dakota'),
  WY: noTaxModule('WY', 'Wyoming'),
  AK: noTaxModule('AK', 'Alaska'),
  NH: noTaxModule('NH', 'New Hampshire', 'New Hampshire repealed its interest & dividends tax effective 2025.'),
  // Flat states (rates verified for 2024/2025/2026)
  CO: flatModule('CO', 'Colorado', { 2024: 0.044, 2025: 0.044, 2026: 0.044 }),
  IL: flatModule('IL', 'Illinois', { 2024: 0.0495, 2025: 0.0495, 2026: 0.0495 }),
  PA: flatModule('PA', 'Pennsylvania', { 2024: 0.0307, 2025: 0.0307, 2026: 0.0307 }),
  MI: flatModule('MI', 'Michigan', { 2024: 0.0425, 2025: 0.0425, 2026: 0.0425 }),
  IN: flatModule('IN', 'Indiana', { 2024: 0.0305, 2025: 0.03, 2026: 0.0295 }),
  UT: flatModule('UT', 'Utah', { 2024: 0.0455, 2025: 0.045, 2026: 0.045 }),
  NC: flatModule('NC', 'North Carolina', { 2024: 0.045, 2025: 0.0425, 2026: 0.0399 }),
  KY: flatModule('KY', 'Kentucky', { 2024: 0.04, 2025: 0.04, 2026: 0.035 }),
  AZ: flatModule('AZ', 'Arizona', { 2024: 0.025, 2025: 0.025, 2026: 0.025 }),
  GA: flatModule('GA', 'Georgia', { 2024: 0.0539, 2025: 0.0519, 2026: 0.0519 }),
  // Bracketed
  CA: californiaModule,
  NY: newYorkModule,
  // Fallback
  OTHER: genericModule,
};

export const STATE_OPTIONS: Array<{ code: string; name: string }> = [
  ...Object.values(STATE_MODULES)
    .filter(m => m.code !== 'OTHER')
    .map(m => ({ code: m.code, name: m.name }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  { code: 'OTHER', name: 'Other (flat rate override)' },
];

export function computeStateTax(stateCode: string, inputs: StateTaxInputs): StateTaxResult {
  const mod = STATE_MODULES[stateCode] ?? STATE_MODULES.OTHER;
  return mod.compute(inputs);
}
