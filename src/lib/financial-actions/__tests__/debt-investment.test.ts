import { beforeEach, expect, it, vi } from 'vitest';
import { defaultPlanner } from '@/lib/debt-investment-planner';
const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ default: { gnucash_web_tool_config: { findMany: mocks.findMany } } }));
import { loadDebtInvestmentActions } from '../debt-investment';
beforeEach(() => vi.resetAllMocks());
it('only reads saved personal scenarios from the current book and includes trace inputs', async () => {
  mocks.findMany.mockResolvedValue([{ id: 1, name: 'Home', config: defaultPlanner(), updated_at: new Date('2026-09-16') }, { id: 2, config: {} }]);
  const actions = await loadDebtInvestmentActions(3, 'book-a');
  expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { user_id: 3, book_guid: 'book-a', tool_type: 'debt-vs-invest' }, take: 20 }));
  expect(actions).toHaveLength(1);
  expect(actions[0].operations[0].href).toBe('/tools/debt-vs-invest?scenario=1');
  expect(actions[0].trace.steps).toHaveLength(3);
  expect(actions[0].trace.metadata?.scenario).toEqual(defaultPlanner());
});
it('flags unfunded comparisons instead of recommending them', async () => {
  const scenario = defaultPlanner(); scenario.debts[0].rateChanges = [{ month: 1, rate: 5, payment: 5000 }];
  mocks.findMany.mockResolvedValue([{ id: 1, name: 'Home', config: scenario, updated_at: new Date() }]);
  const [action] = await loadDebtInvestmentActions(3, 'book-a');
  expect(action.severity).toBe('warning'); expect(action.trace.result).toBeNull();
});
