export interface PerformanceHistoryPoint {
  date: string;
  value: number;
}

export interface PerformanceCashFlowPoint {
  date: string;
  amount: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_XIRR_RATE = 10;
const MIN_XIRR_RATE = -0.9999;

function parseDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function yearFraction(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (365.25 * MS_PER_DAY);
}

function aggregateCashFlowsByDate(cashFlows: PerformanceCashFlowPoint[]): Map<string, number> {
  const byDate = new Map<string, number>();
  for (const flow of cashFlows) {
    byDate.set(flow.date, (byDate.get(flow.date) || 0) + flow.amount);
  }
  return byDate;
}

export function calculateTimeWeightedReturn(
  history: PerformanceHistoryPoint[],
  cashFlows: PerformanceCashFlowPoint[]
): number {
  if (history.length < 2) return 0;

  const flowByDate = aggregateCashFlowsByDate(cashFlows);
  let compoundedReturn = 1;

  for (let index = 1; index < history.length; index += 1) {
    const previousValue = history[index - 1].value;
    const currentPoint = history[index];
    const flow = flowByDate.get(currentPoint.date) || 0;

    if (Math.abs(previousValue) < 0.000001) {
      continue;
    }

    const periodReturn = (currentPoint.value - flow) / previousValue - 1;
    compoundedReturn *= 1 + periodReturn;
  }

  return (compoundedReturn - 1) * 100;
}

function xnpv(rate: number, cashFlows: Array<{ date: Date; amount: number }>): number {
  const startDate = cashFlows[0].date;

  return cashFlows.reduce((sum, cashFlow) => {
    const years = yearFraction(startDate, cashFlow.date);
    return sum + cashFlow.amount / Math.pow(1 + rate, years);
  }, 0);
}

function xnpvDerivative(rate: number, cashFlows: Array<{ date: Date; amount: number }>): number {
  const startDate = cashFlows[0].date;

  return cashFlows.reduce((sum, cashFlow) => {
    const years = yearFraction(startDate, cashFlow.date);
    if (years === 0) return sum;
    return sum - (years * cashFlow.amount) / Math.pow(1 + rate, years + 1);
  }, 0);
}

function solveXirr(cashFlows: Array<{ date: Date; amount: number }>): number | null {
  let rate = 0.1;

  for (let iteration = 0; iteration < 50; iteration += 1) {
    const value = xnpv(rate, cashFlows);
    const derivative = xnpvDerivative(rate, cashFlows);

    if (Math.abs(value) < 0.000001) {
      return rate;
    }

    if (Math.abs(derivative) < 0.000001) {
      break;
    }

    const nextRate = rate - value / derivative;
    if (nextRate <= MIN_XIRR_RATE || nextRate > MAX_XIRR_RATE || !Number.isFinite(nextRate)) {
      break;
    }

    rate = nextRate;
  }

  let low = MIN_XIRR_RATE;
  let high = MAX_XIRR_RATE;
  let lowValue = xnpv(low, cashFlows);
  let highValue = xnpv(high, cashFlows);

  if (lowValue === 0) return low;
  if (highValue === 0) return high;
  if (lowValue * highValue > 0) return null;

  for (let iteration = 0; iteration < 100; iteration += 1) {
    const mid = (low + high) / 2;
    const midValue = xnpv(mid, cashFlows);

    if (Math.abs(midValue) < 0.000001) {
      return mid;
    }

    if (lowValue * midValue < 0) {
      high = mid;
      highValue = midValue;
    } else {
      low = mid;
      lowValue = midValue;
    }
  }

  return (low + high) / 2;
}

export function calculateMoneyWeightedReturn(
  history: PerformanceHistoryPoint[],
  cashFlows: PerformanceCashFlowPoint[]
): number {
  if (history.length === 0) return 0;

  const startPoint = history[0];
  const endPoint = history[history.length - 1];
  const startDate = parseDate(startPoint.date);
  const endDate = parseDate(endPoint.date);

  const investorCashFlows = [
    { date: startDate, amount: -startPoint.value },
    ...cashFlows
      .filter((flow) => flow.date >= startPoint.date && flow.date <= endPoint.date)
      .map((flow) => ({
        date: parseDate(flow.date),
        amount: -flow.amount,
      })),
    { date: endDate, amount: endPoint.value },
  ];

  const hasPositive = investorCashFlows.some((cashFlow) => cashFlow.amount > 0);
  const hasNegative = investorCashFlows.some((cashFlow) => cashFlow.amount < 0);

  if (!hasPositive || !hasNegative) {
    return 0;
  }

  const annualRate = solveXirr(investorCashFlows);
  if (annualRate === null || !Number.isFinite(annualRate)) {
    return 0;
  }

  const totalYears = yearFraction(startDate, endDate);
  if (totalYears <= 0) {
    return annualRate * 100;
  }

  const periodRate = Math.pow(1 + annualRate, totalYears) - 1;
  return periodRate * 100;
}
