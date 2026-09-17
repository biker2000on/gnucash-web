/** Nominal, before-tax comparison with monthly debt accrual and end-month investing. */
export interface DebtInvestmentInputs {
  balance: number;
  debtRate: number;
  monthlyPayment: number;
  lumpSum: number;
  extraMonthly: number;
  annualReturn: number;
  years: number;
  splitPercent: number;
}

export const STRATEGIES = ['payoff', 'invest', 'split'] as const;
export type DebtInvestmentStrategy = typeof STRATEGIES[number];
export interface ProjectionPoint {
  month: number;
  debt: number;
  investments: number;
  netWorth: number;
  interest: number;
}
export interface DebtInvestmentPlan {
  strategy: DebtInvestmentStrategy;
  payoffMonth: number | null;
  points: ProjectionPoint[];
  final: ProjectionPoint;
}

export const INPUT_LIMITS: Record<keyof DebtInvestmentInputs, [number, number]> = {
  balance: [0, 1e9], debtRate: [0, 100], monthlyPayment: [0, 1e7],
  lumpSum: [0, 1e9], extraMonthly: [0, 1e7], annualReturn: [-99, 100],
  years: [1, 50], splitPercent: [0, 100],
};

export function validateDebtInvestmentInputs(input: DebtInvestmentInputs): string | null {
  for (const key of Object.keys(INPUT_LIMITS) as (keyof DebtInvestmentInputs)[]) {
    const [min, max] = INPUT_LIMITS[key];
    if (!Number.isFinite(input[key]) || input[key] < min || input[key] > max) {
      return `${key} must be between ${min} and ${max}.`;
    }
  }
  if (!Number.isInteger(input.years)) return 'Comparison years must be a whole number.';
  if (input.balance > 0 && input.monthlyPayment <= input.balance * input.debtRate / 1200) {
    return 'The scheduled payment must exceed the first month’s interest so the original debt can be repaid.';
  }
  return null;
}

function project(input: DebtInvestmentInputs, strategy: DebtInvestmentStrategy): DebtInvestmentPlan {
  const share = strategy === 'payoff' ? 1 : strategy === 'invest' ? 0 : input.splitPercent / 100;
  const initialPayment = Math.min(input.balance, input.lumpSum * share);
  let debt = input.balance - initialPayment;
  let investments = input.lumpSum - initialPayment;
  let interest = 0;
  let payoffMonth: number | null = debt === 0 ? 0 : null;
  const monthlyReturn = Math.expm1(Math.log1p(input.annualReturn / 100) / 12);
  const budget = input.monthlyPayment + input.extraMonthly;
  const points: ProjectionPoint[] = [{ month: 0, debt, investments, netWorth: investments - debt, interest }];
  for (let month = 1; month <= input.years * 12; month++) {
    const accrued = debt * input.debtRate / 1200;
    interest += accrued;
    const due = debt + accrued;
    const payment = Math.min(due, input.monthlyPayment + input.extraMonthly * share);
    debt = Math.max(0, due - payment);
    // Includes the unused portion of the final payment and all future freed payments.
    investments = investments * (1 + monthlyReturn) + budget - payment;
    if (debt === 0 && payoffMonth === null) payoffMonth = month;
    points.push({ month, debt, investments, netWorth: investments - debt, interest });
  }
  return { strategy, payoffMonth, points, final: points[points.length - 1] };
}

export function compareDebtInvestment(input: DebtInvestmentInputs) {
  const error = validateDebtInvestmentInputs(input);
  if (error) throw new Error(error);
  const plans = Object.fromEntries(STRATEGIES.map(strategy => [strategy, project(input, strategy)])) as Record<DebtInvestmentStrategy, DebtInvestmentPlan>;
  // The debt rate is nominal with monthly compounding; investment returns are effective annual.
  // Without taxes/fees, their effective annual equality is the exact break-even rate.
  const hasChoice = input.balance > 0 && (input.lumpSum > 0 || (input.extraMonthly > 0 && input.balance * (1 + input.debtRate / 1200) > input.monthlyPayment));
  const breakEvenReturn = hasChoice ? (Math.pow(1 + input.debtRate / 1200, 12) - 1) * 100 : null;
  const rates = [...new Set([-5, 0, 2, 4, 6, 8, 10, 12, input.annualReturn, ...(breakEvenReturn !== null && breakEvenReturn <= 100 ? [breakEvenReturn] : [])])].sort((a, b) => a - b);
  const sensitivity = rates.map(rate => {
    const atRate = { ...input, annualReturn: rate };
    const baseline = project(atRate, 'invest').final.netWorth;
    return {
      rate,
      payoff: project(atRate, 'payoff').final.netWorth - baseline,
      split: project(atRate, 'split').final.netWorth - baseline,
    };
  });
  return { plans, breakEvenReturn, sensitivity };
}
