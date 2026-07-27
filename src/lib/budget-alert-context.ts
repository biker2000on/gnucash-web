import type { PeriodRange } from '@/lib/budget-actuals';

export type BudgetAlertContextKind = 'over' | 'threshold' | 'projected';

const TITLES: Record<BudgetAlertContextKind, string> = {
  over: 'Budget exceeded',
  threshold: 'Budget threshold reached',
  projected: 'Projected budget overspend',
};

const CONTEXT_PREFIX =
  /^Budget "[^"]+"; period .+? \(\d{4}-\d{2}-\d{2} through \d{4}-\d{2}-\d{2}\)\.\s*/;

export function parseBudgetAlertSourceId(sourceId: string | null): {
  budgetGuid: string;
  accountGuid: string;
  periodNum: number;
  kind: BudgetAlertContextKind;
} | null {
  if (!sourceId) return null;
  const match = /^([^:]+):([^:]+):p(\d+):(over|threshold|projected)$/.exec(sourceId);
  if (!match) return null;
  return {
    budgetGuid: match[1],
    accountGuid: match[2],
    periodNum: Number(match[3]),
    kind: match[4] as BudgetAlertContextKind,
  };
}

export function contextualizeBudgetAlert(
  kind: BudgetAlertContextKind,
  message: string,
  budgetName: string,
  period: PeriodRange,
): { title: string; message: string } {
  const detail = message.replace(CONTEXT_PREFIX, '');
  return {
    title: `${TITLES[kind]} — ${budgetName} — ${period.label}`,
    message:
      `Budget "${budgetName}"; period ${period.label} ` +
      `(${period.start} through ${period.end}). ${detail}`,
  };
}
