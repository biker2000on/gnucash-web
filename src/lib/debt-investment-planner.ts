import { z } from 'zod';
import { HISTORICAL_RETURNS } from './fire/historical-returns';
import { STRATEGIES, type DebtInvestmentStrategy } from './debt-vs-invest';

const amount = z.number().finite().min(0).max(1e9);
const percent = z.number().finite().min(0).max(100);
const month = z.number().int().min(1).max(600);
export const PlannerDebtSchema = z.object({
  id: z.string().min(1).max(100), name: z.string().trim().min(1).max(100),
  balance: amount, rate: percent, payment: amount,
  eligibleInterestPercent: percent.default(0),
  insurance: amount.default(0), cancelInsuranceBalance: amount.default(0),
  cancelInsuranceMonth: z.number().int().min(0).max(600).default(0),
  penaltyPercent: percent.default(0), penaltyThroughMonth: z.number().int().min(0).max(600).default(0),
  annualExtraLimit: amount.default(0),
  rateChanges: z.array(z.object({ month, rate: percent, payment: amount })).max(20).default([]),
  recast: z.object({ month, remainingMonths: month, fee: amount }).nullable().default(null),
  refinance: z.object({ month, rate: percent, termMonths: month, cost: amount, financeCost: z.boolean() }).nullable().default(null),
});
export type PlannerDebt = z.infer<typeof PlannerDebtSchema>;
export const PlannerSchema = z.object({
  version: z.literal(2).default(2), debts: z.array(PlannerDebtSchema).min(1).max(12),
  lumpSum: amount, extraMonthly: amount, reserve: amount.default(0), existingInvestments: amount.default(0),
  annualReturn: z.number().finite().min(-90).max(50), years: z.number().int().min(1).max(50), splitPercent: percent,
  priority: z.enum(['avalanche', 'snowball', 'listed']).default('avalanche'),
  accountType: z.enum(['taxable', 'deferred', 'taxFree']).default('taxable'),
  lumpAlreadyInvested: z.boolean().default(false), lumpGainPercent: percent.default(0), existingBasisPercent: percent.default(100),
  capitalGainsTax: percent.max(60).default(0), withdrawalTax: percent.max(60).default(0), earlyPenalty: percent.max(30).default(0),
  accessAge: z.number().min(0).max(100).default(59.5), deductibleContributions: z.boolean().default(false),
  feePercent: percent.max(10).default(0), dividendYield: percent.max(20).default(0), dividendTax: percent.max(60).default(0),
  marginalTax: percent.max(60).default(0), standardDeduction: amount.default(0), otherItemized: amount.default(0),
  currentAge: z.number().min(18).max(100).default(40), annualSpending: amount.default(40000),
  withdrawalPercent: z.number().finite().min(1).max(10).default(4), inflation: percent.max(15).default(2.5),
  stockPercent: percent.default(80), simulations: z.number().int().min(50).max(1000).default(250),
  seed: z.number().int().min(1).max(2147483647).default(42),
}).superRefine((s, ctx) => {
  const issue = (message: string, path: (string | number)[] = []) => ctx.addIssue({ code: 'custom', message, path });
  if (new Set(s.debts.map(d => d.id)).size !== s.debts.length) issue('Each debt must have a unique identifier.');
  if (s.withdrawalTax + s.earlyPenalty >= 100) issue('Withdrawal tax and penalty must total less than 100%.');
  const sourceTax = s.lumpAlreadyInvested ? s.accountType === 'taxable' ? s.lumpGainPercent * s.capitalGainsTax / 10000 : s.accountType === 'deferred' ? (s.withdrawalTax + (s.currentAge < s.accessAge ? s.earlyPenalty : 0)) / 100 : 0 : 0;
  if (s.reserve > s.lumpSum * (1 - sourceTax)) issue('The protected cash reserve exceeds the lump sum available after withdrawal taxes.', ['reserve']);
  s.debts.forEach((d, index) => {
    if (d.balance > 0 && d.payment <= d.balance * d.rate / 1200) issue(`${d.name}: scheduled payment must exceed monthly interest.`, ['debts', index, 'payment']);
    if (new Set(d.rateChanges.map(e => e.month)).size !== d.rateChanges.length) issue(`${d.name}: use one rate change per month.`);
    if (d.recast && d.refinance && d.recast.month === d.refinance.month) issue(`${d.name}: recast and refinance must occur in different months.`);
    if (d.rateChanges.some(e => e.month === d.recast?.month || e.month === d.refinance?.month)) issue(`${d.name}: rate changes cannot share a month with recasting or refinancing.`);
  });
});
export type PlannerScenario = z.infer<typeof PlannerSchema>;
export const STRATEGY_NAMES: Record<DebtInvestmentStrategy, string> = { payoff: 'Pay off debt', invest: 'Invest', split: 'Split' };
export function newPlannerDebt(id = 'debt-1'): PlannerDebt {
  return PlannerDebtSchema.parse({ id, name: 'Mortgage', balance: 250000, rate: 5, payment: 1500 });
}
export function defaultPlanner(): PlannerScenario {
  return PlannerSchema.parse({ debts: [newPlannerDebt()], lumpSum: 25000, extraMonthly: 500, annualReturn: 7, years: 20, splitPercent: 50 });
}
export interface PlannerPoint {
  month: number; debt: number; investments: number; afterTaxInvestments: number;
  netWorth: number; interest: number; taxBenefit: number; taxes: number; fees: number; insurance: number;
  requiredPayment: number; shortfall: number;
}
export interface PlannerPlan {
  strategy: DebtInvestmentStrategy; points: PlannerPoint[]; final: PlannerPoint;
  debts: { id: string; name: string; balance: number; interest: number; payoffMonth: number | null }[];
  payoffMonth: number | null; financialIndependenceMonth: number | null;
}
export const PLANNER_ASSUMPTIONS = [
  'Every strategy starts with the same assets and uses the same fixed monthly budget: original scheduled payments, original insurance premiums, and extra cash. Freed payments are reinvested.',
  'Interest accrues monthly; events occur before that month’s interest. Investment returns are effective annual total returns, converted to monthly rates. Contributions occur at month end.',
  'Eligible interest is the user-confirmed share after qualified-debt limits. The incremental deduction is max(standard, other itemized + eligible interest) minus max(standard, other itemized). The modeled benefit is reinvested every 12 months.',
  'Taxable dividends are reinvested after tax and added to basis; capital-gains tax applies to positive unrealized gains on hypothetical liquidation. No capital-loss tax credit is assumed. Fees reduce returns.',
  'Tax-deferred contributions are either after-tax basis, or grossed up using the marginal tax rate when marked deductible. Contribution limits and eligibility are not determined by this calculator. Tax-free treatment assumes qualified withdrawals.',
  'Insurance cancellation uses a lender-confirmed balance or month, not automatic legal eligibility. Prepayment penalties apply to extra principal through the configured month. A zero annual extra-payment limit means unlimited.',
  'Refinancing replaces the payment using remaining principal and the new term; costs are either financed or paid from that month’s budget. Recasting occurs before monthly payments and uses the specified remaining term.',
  'Financial independence is the first projected month after-tax investments cover inflation-adjusted spending plus remaining debt payments at the chosen withdrawal rate. It is a threshold estimate, not a sustainable-retirement guarantee.',
];

function paymentFor(balance: number, rate: number, months: number): number {
  const r = rate / 1200;
  return r === 0 ? balance / months : balance * r / -Math.expm1(-months * Math.log1p(r));
}
function liquidValue(s: PlannerScenario, balance: number, basis: number, monthIndex: number): number {
  if (s.accountType === 'taxFree') return balance;
  const tax = s.accountType === 'taxable' ? s.capitalGainsTax : s.withdrawalTax + (s.currentAge + monthIndex / 12 < s.accessAge ? s.earlyPenalty : 0);
  return balance - Math.max(0, balance - basis) * tax / 100;
}

/** Caller validates once before running many shared-path projections. No mutation of the scenario. */
function project(s: PlannerScenario, strategy: DebtInvestmentStrategy, returns?: readonly number[]): PlannerPlan {
  const share = strategy === 'payoff' ? 1 : strategy === 'invest' ? 0 : s.splitPercent / 100;
  const debts = s.debts.map(d => ({ ...d, remaining: d.balance, currentRate: d.rate, currentPayment: d.payment, extraThisYear: 0, interest: 0, payoffMonth: d.balance === 0 ? 0 as number | null : null }));
  const initialTaxRate = s.lumpAlreadyInvested ? s.accountType === 'taxable' ? s.lumpGainPercent * s.capitalGainsTax / 10000 : s.accountType === 'deferred' ? (s.withdrawalTax + (s.currentAge < s.accessAge ? s.earlyPenalty : 0)) / 100 : 0 : 0;
  const grossReserve = s.reserve / (1 - initialTaxRate);
  const availableLump = s.lumpSum - grossReserve;
  let taxes = grossReserve - s.reserve;
  let fees = 0;
  let insurance = 0;
  let taxBenefit = 0;
  let shortfall = 0;
  let eligibleInterest = 0;
  const budget = s.extraMonthly + s.debts.reduce((sum, d) => sum + d.payment + d.insurance, 0);

  function ordered() {
    return [...debts].sort((a, b) => s.priority === 'avalanche' ? b.currentRate - a.currentRate : s.priority === 'snowball' ? a.remaining - b.remaining : 0);
  }
  function prepay(cash: number, m: number): number {
    const original = cash;
    for (const d of ordered()) {
      if (d.remaining <= 0) continue;
      const penalty = m <= d.penaltyThroughMonth ? d.penaltyPercent / 100 : 0;
      const allowed = d.annualExtraLimit === 0 ? Infinity : Math.max(0, d.annualExtraLimit - d.extraThisYear);
      const principal = Math.min(d.remaining, cash / (1 + penalty), allowed);
      const cost = principal * (1 + penalty);
      d.remaining = Math.max(0, d.remaining - principal);
      d.extraThisYear += principal;
      fees += cost - principal;
      cash -= cost;
      if (d.remaining === 0 && d.payoffMonth === null) d.payoffMonth = m;
    }
    return original - cash;
  }
  const netSpent = prepay(availableLump * share * (1 - initialTaxRate), 0);
  const grossSpent = netSpent / (1 - initialTaxRate);
  taxes += grossSpent - netSpent;
  let investments = s.existingInvestments + availableLump - grossSpent;
  let basis = s.existingInvestments * s.existingBasisPercent / 100 + (availableLump - grossSpent) * (s.lumpAlreadyInvested ? s.accountType === 'deferred' ? 0 : 1 - s.lumpGainPercent / 100 : 1);
  let fiMonth: number | null = null;
  function snapshot(m: number, requiredPayment: number): PlannerPoint {
    const debt = debts.reduce((sum, d) => sum + d.remaining, 0);
    const afterTaxInvestments = liquidValue(s, investments, basis, m);
    const target = (s.annualSpending * Math.pow(1 + s.inflation / 100, m / 12) + requiredPayment * 12) * 100 / s.withdrawalPercent;
    if (fiMonth === null && afterTaxInvestments >= target && shortfall === 0) fiMonth = m;
    return { month: m, debt, investments, afterTaxInvestments, netWorth: afterTaxInvestments + s.reserve - debt, interest: debts.reduce((sum, d) => sum + d.interest, 0), taxes, taxBenefit, fees, insurance, requiredPayment, shortfall };
  }
  function insuranceFor(d: typeof debts[number], m: number) {
    return d.remaining > d.cancelInsuranceBalance && (d.cancelInsuranceMonth === 0 || m < d.cancelInsuranceMonth) ? d.insurance : 0;
  }
  const points = [snapshot(0, debts.reduce((sum, d) => sum + (d.remaining > 0 ? d.currentPayment + insuranceFor(d, 0) : 0), 0))];
  for (let m = 1; m <= s.years * 12; m++) {
    // Month zero and months 1–12 form the first model year for lender caps.
    if (m > 1 && m % 12 === 1) debts.forEach(d => { d.extraThisYear = 0; });
    const annualReturn = returns?.[Math.floor((m - 1) / 12)] ?? s.annualReturn / 100;
    investments *= Math.pow(1 + annualReturn, 1 / 12);
    const investmentFee = investments * (1 - Math.pow(1 - s.feePercent / 100, 1 / 12));
    investments -= investmentFee;
    fees += investmentFee;
    if (s.accountType === 'taxable') {
      const dividend = Math.min(investments, investments * s.dividendYield / 1200);
      const dividendTax = dividend * s.dividendTax / 100;
      investments -= dividendTax;
      taxes += dividendTax;
      basis += dividend - dividendTax;
    }
    let cash = budget;
    for (const d of debts) {
      if (d.remaining === 0) continue;
      const change = d.rateChanges.find(e => e.month === m);
      if (change) { d.currentRate = change.rate; d.currentPayment = change.payment; }
      if (d.refinance?.month === m) {
        const penalty = m <= d.penaltyThroughMonth ? d.remaining * d.penaltyPercent / 100 : 0;
        const cost = d.refinance.cost + penalty;
        fees += cost;
        if (d.refinance.financeCost) d.remaining += cost;
        else cash -= cost;
        d.currentRate = d.refinance.rate;
        d.currentPayment = paymentFor(d.remaining, d.currentRate, d.refinance.termMonths);
      }
      if (d.recast?.month === m) {
        fees += d.recast.fee;
        cash -= d.recast.fee;
        d.currentPayment = paymentFor(d.remaining, d.currentRate, d.recast.remainingMonths);
      }
      const premium = insuranceFor(d, m);
      cash -= premium;
      insurance += premium;
    }
    // Required cash costs cannot be silently borrowed; expose any funding gap.
    if (cash < 0) { shortfall += -cash; cash = 0; }
    const dues = debts.map(d => {
      const accrued = d.remaining * d.currentRate / 1200;
      d.interest += accrued;
      eligibleInterest += accrued * d.eligibleInterestPercent / 100;
      d.remaining += accrued;
      return Math.min(d.remaining, d.currentPayment);
    });
    const dueTotal = dues.reduce((a, b) => a + b, 0);
    const fraction = dueTotal > cash + 1e-8 ? cash / dueTotal : 1;
    if (fraction < 1) shortfall += dueTotal - cash;
    debts.forEach((d, i) => {
      const paid = dues[i] * fraction;
      d.remaining = Math.max(0, d.remaining - paid);
      cash -= paid;
      if (d.remaining === 0 && d.payoffMonth === null) d.payoffMonth = m;
    });
    cash = Math.max(0, cash);
    cash -= prepay(cash * share, m);
    if (m % 12 === 0) {
      const incremental = Math.max(s.standardDeduction, s.otherItemized + eligibleInterest) - Math.max(s.standardDeduction, s.otherItemized);
      const benefit = incremental * s.marginalTax / 100;
      cash += benefit;
      taxBenefit += benefit;
      eligibleInterest = 0;
    }
    const gross = s.accountType === 'deferred' && s.deductibleContributions ? cash / (1 - s.marginalTax / 100) : cash;
    investments += gross;
    basis += s.accountType === 'deferred' && s.deductibleContributions ? 0 : cash;
    const requiredPayment = debts.reduce((sum, d) => sum + (d.remaining > 0 ? d.currentPayment + insuranceFor(d, m + 1) : 0), 0);
    points.push(snapshot(m, requiredPayment));
  }
  return { strategy, points, final: points[points.length - 1], debts: debts.map(d => ({ id: d.id, name: d.name, balance: d.remaining, interest: d.interest, payoffMonth: d.payoffMonth })), payoffMonth: debts.every(d => d.payoffMonth !== null) ? Math.max(...debts.map(d => d.payoffMonth!)) : null, financialIndependenceMonth: fiMonth };
}

export function comparePlanner(raw: unknown) {
  const s = PlannerSchema.parse(raw);
  const plans = Object.fromEntries(STRATEGIES.map(strategy => [strategy, project(s, strategy)])) as Record<DebtInvestmentStrategy, PlannerPlan>;
  const sensitivity = [...new Set([-10, -5, 0, 2, 4, 6, 8, 10, 15, s.annualReturn])].sort((a, b) => a - b).map(rate => {
    const scenario = { ...s, annualReturn: rate };
    const invest = project(scenario, 'invest').final.netWorth;
    return { rate, payoff: project(scenario, 'payoff').final.netWorth - invest, split: project(scenario, 'split').final.netWorth - invest };
  });
  const difference = (rate: number) => {
    const scenario = { ...s, annualReturn: rate };
    return project(scenario, 'payoff').final.netWorth - project(scenario, 'invest').final.netWorth;
  };
  // Search rather than assume a single interest-rate equality once taxes, fees,
  // lender events and multiple debts can change the shape of the comparison.
  const breakEvenRates: number[] = [];
  let previousRate = -90;
  let previous = difference(previousRate);
  let identical = Math.round(previous * 100) === 0;
  for (let rate = -85; rate <= 50; rate += 5) {
    const next = difference(rate);
    identical = identical && Math.round(next * 100) === 0;
    if (previous * next < 0) {
      let low = previousRate; let high = rate; let atLow = previous;
      for (let i = 0; i < 32; i++) {
        const mid = (low + high) / 2;
        const atMid = difference(mid);
        if (atLow * atMid > 0) { low = mid; atLow = atMid; } else high = mid;
      }
      breakEvenRates.push((low + high) / 2);
    } else if (next === 0 && previous !== 0) breakEvenRates.push(rate);
    previousRate = rate; previous = next;
  }
  return { plans, sensitivity, breakEvenRates: identical ? [] : breakEvenRates, identical };
}

export function projectPlanner(raw: unknown, strategy: DebtInvestmentStrategy): PlannerPlan {
  return project(PlannerSchema.parse(raw), strategy);
}

function percentile(sorted: number[], fraction: number) {
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}
export function simulatePlanner(raw: unknown) {
  const s = PlannerSchema.parse(raw);
  let seed = s.seed >>> 0;
  function random() { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; }
  const outcomes = Object.fromEntries(STRATEGIES.map(k => [k, [] as number[]])) as Record<DebtInvestmentStrategy, number[]>;
  const wins = { payoff: 0, invest: 0, split: 0 };
  const ties = { payoff: 0, invest: 0, split: 0 };
  const annual = Array.from({ length: s.years + 1 }, () => ({ payoff: [] as number[], invest: [] as number[], split: [] as number[] }));
  let invalidRuns = 0;
  for (let run = 0; run < s.simulations; run++) {
    // One paired stock/bond row per year; the identical path drives all strategies.
    const path = Array.from({ length: s.years }, () => {
      const row = HISTORICAL_RETURNS[Math.floor(random() * HISTORICAL_RETURNS.length)];
      return row.stocks * s.stockPercent / 100 + row.bonds * (1 - s.stockPercent / 100);
    });
    const plans = Object.fromEntries(STRATEGIES.map(k => [k, project(s, k, path)])) as Record<DebtInvestmentStrategy, PlannerPlan>;
    if (STRATEGIES.some(k => plans[k].final.shortfall > 0)) invalidRuns++;
    for (const k of STRATEGIES) {
      outcomes[k].push(plans[k].final.netWorth);
      const diff = Math.round((plans[k].final.netWorth - plans.invest.final.netWorth) * 100);
      if (diff > 0) wins[k]++;
      if (diff === 0) ties[k]++;
      plans[k].points.forEach(p => { if (p.month % 12 === 0) annual[p.month / 12][k].push(p.netWorth); });
    }
  }
  const summaries = STRATEGIES.map(strategy => {
    const values = outcomes[strategy].sort((a, b) => a - b);
    return { strategy, low: percentile(values, 0.1), median: percentile(values, 0.5), high: percentile(values, 0.9), aheadPercent: wins[strategy] * 100 / s.simulations, tiePercent: ties[strategy] * 100 / s.simulations };
  });
  const bands: Record<string, number>[] = annual.map((row, year) => {
    for (const k of STRATEGIES) row[k].sort((a, b) => a - b);
    return { year, ...Object.fromEntries(STRATEGIES.flatMap(k => [[k, percentile(row[k], 0.5)], [`${k}Low`, percentile(row[k], 0.1)], [`${k}High`, percentile(row[k], 0.9)]])) };
  });
  return { summaries, bands, invalidRuns, runs: s.simulations };
}
