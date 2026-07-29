import { describe, expect, it } from 'vitest';
import {
  contextualizeBudgetAlert,
  currentYearActiveBudgetPeriod,
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

  it('accepts only the active period of a budget that starts this year', () => {
    const periods = [
      { periodNum: 0, start: '2026-01-01', end: '2026-01-31', label: 'Jan 2026' },
      { periodNum: 1, start: '2026-02-01', end: '2026-02-28', label: 'Feb 2026' },
    ];

    expect(currentYearActiveBudgetPeriod(periods, '2026-02-15', 1)).toEqual(periods[1]);
    expect(currentYearActiveBudgetPeriod(periods, '2026-02-15', 0)).toBeNull();
    expect(currentYearActiveBudgetPeriod(periods, '2027-02-15', 1)).toBeNull();
  });

  it('rejects an older budget even if an extended period overlaps this year', () => {
    const periods = [{
      periodNum: 0,
      start: '2017-01-01',
      end: '2026-12-31',
      label: 'Legacy budget',
    }];

    expect(currentYearActiveBudgetPeriod(periods, '2026-07-27', 0)).toBeNull();
  });
});
