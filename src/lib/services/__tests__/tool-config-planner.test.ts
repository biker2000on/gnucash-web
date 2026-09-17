import { beforeEach, expect, it, vi } from 'vitest';
import { defaultPlanner } from '@/lib/debt-investment-planner';
const mocks = vi.hoisted(() => ({ create: vi.fn(), findUnique: vi.fn(), update: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ default: { gnucash_web_tool_config: mocks } }));
import { ToolConfigService } from '../tool-config.service';
beforeEach(() => vi.resetAllMocks());
it('validates planner inputs before persisting', async () => {
  await expect(ToolConfigService.create(3, 'book-a', { toolType: 'debt-vs-invest', name: 'Bad', config: {} })).rejects.toThrow();
  expect(mocks.create).not.toHaveBeenCalled();
  await ToolConfigService.create(3, 'book-a', { toolType: 'debt-vs-invest', name: 'Home', config: defaultPlanner() });
  expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({ user_id: 3, book_guid: 'book-a', config: defaultPlanner() }) });
});
it('checks ownership before updating and rejects corrupt planner inputs', async () => {
  mocks.findUnique.mockResolvedValue({ user_id: 4, book_guid: 'book-a', tool_type: 'debt-vs-invest' });
  expect(await ToolConfigService.update(1, 3, 'book-a', { config: defaultPlanner() })).toBeNull();
  mocks.findUnique.mockResolvedValue({ user_id: 3, book_guid: 'book-a', tool_type: 'debt-vs-invest' });
  await expect(ToolConfigService.update(1, 3, 'book-a', { config: { ...defaultPlanner(), reserve: 1e8 } })).rejects.toThrow();
  expect(mocks.update).not.toHaveBeenCalled();
});
