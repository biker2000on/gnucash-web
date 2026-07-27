import { describe, expect, it } from 'vitest';
import {
  contextualizeBudgetAlert,
  parseBudgetAlertSourceId,
} from '@/lib/budget-alert-context';

const period = {
  periodNum: 6,
  start: '2026-07-01',
  end: '2026-07-31',
  label: 'Jul 2026',
};

describe('budget alert context', () => {
  it('parses the budget, account, period, and alert kind from the dedupe key', () => {
    expect(parseBudgetAlertSourceId('budget-guid:account-guid:p6:over')).toEqual({
      budgetGuid: 'budget-guid',
      accountGuid: 'account-guid',
      periodNum: 6,
      kind: 'over',
    });
    expect(parseBudgetAlertSourceId('not-a-budget-alert')).toBeNull();
  });

  it('names the budget and exact period in validation-facing content', () => {
    const content = contextualizeBudgetAlert(
      'over',
      'Groceries is over budget: $620 spent of $500.',
      '2026 Household',
      period,
    );

    expect(content.title).toBe('Budget exceeded — 2026 Household — Jul 2026');
    expect(content.message).toBe(
      'Budget "2026 Household"; period Jul 2026 ' +
      '(2026-07-01 through 2026-07-31). Groceries is over budget: $620 spent of $500.',
    );
  });

  it('replaces existing context instead of duplicating it', () => {
    const first = contextualizeBudgetAlert(
      'over',
      'Dining is over budget.',
      'Household',
      period,
    );
    const second = contextualizeBudgetAlert('over', first.message, 'Household', period);

    expect(second).toEqual(first);
    expect(second.message.match(/Budget "Household"/g)).toHaveLength(1);
  });
});
