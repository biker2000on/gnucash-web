import type { PeriodRange } from '@/lib/budget-actuals';
import type { FinancialAction } from './types';

function isBudgetAction(action: FinancialAction): boolean {
  const notificationType = action.metadata?.notificationType;
  return action.metadata?.opportunityPack === 'budget-gaps'
    || action.stableKey.startsWith('opportunity:budget-gaps:')
    || typeof action.metadata?.budgetGuid === 'string'
    || (typeof notificationType === 'string' && notificationType.includes('budget'));
}

function budgetPeriod(value: unknown): PeriodRange | null {
  if (!value || typeof value !== 'object') return null;
  const period = value as Partial<PeriodRange>;
  return typeof period.periodNum === 'number'
    && typeof period.start === 'string'
    && typeof period.end === 'string'
    && typeof period.label === 'string'
    ? period as PeriodRange
    : null;
}

export function actionMatchesCurrentActiveBudget(
  action: FinancialAction,
  asOf: string,
): boolean {
  if (!isBudgetAction(action)) return true;
  const year = Number(asOf.slice(0, 4));
  if (action.metadata?.budgetYear !== year) return false;
  const period = budgetPeriod(action.metadata?.budgetPeriod);
  return period !== null && asOf >= period.start && asOf <= period.end;
}
