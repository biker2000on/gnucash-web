import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireRole, listBatches, scheduleStatementRecovery } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  listBatches: vi.fn(),
  scheduleStatementRecovery: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireRole }));
vi.mock('@/lib/services/statement.service', () => ({ listBatches }));
vi.mock('@/lib/queue/statement-recovery', () => ({ scheduleStatementRecovery }));

import { GET } from './route';

const batches = [{ id: 12, status: 'error', error: 'temporary extraction failure' }];

describe('GET /api/statements recovery authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listBatches.mockResolvedValue(batches);
    scheduleStatementRecovery.mockResolvedValue([12]);
  });

  it('preserves readonly listing access without scheduling mutation jobs', async () => {
    requireRole.mockResolvedValue({
      bookGuid: 'book-1',
      role: 'readonly',
      user: { id: 4 },
    });

    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ batches, recoveryQueued: [] });
    expect(scheduleStatementRecovery).not.toHaveBeenCalled();
  });

  it.each(['edit', 'admin'])('allows %s callers to schedule bounded recovery', async role => {
    requireRole.mockResolvedValue({
      bookGuid: 'book-1',
      role,
      user: { id: 7 },
    });

    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ batches, recoveryQueued: [12] });
    expect(scheduleStatementRecovery).toHaveBeenCalledWith({
      batches,
      bookGuid: 'book-1',
      userId: 7,
    });
  });
});
