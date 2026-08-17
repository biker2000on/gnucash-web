import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  listAttention: vi.fn(),
  rearm: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireRole: mocks.requireRole }));
vi.mock('@/lib/webhook-idempotency', () => ({
  listWebhookIdempotencyAttention: mocks.listAttention,
  rearmWebhookIdempotency: mocks.rearm,
  WEBHOOK_CLAIM_STALE_MINUTES: 5,
  WEBHOOK_MAX_ATTEMPTS: 3,
}));

import { GET, POST } from '../idempotency-attention/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue({ bookGuid: 'session-book', user: { id: 1 } });
  mocks.listAttention.mockResolvedValue([]);
  mocks.rearm.mockResolvedValue(true);
});

describe('webhook idempotency attention', () => {
  it('requires admin to list operator attention', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(mocks.listAttention).toHaveBeenCalledWith('session-book');
  });

  it('requires admin to re-arm a terminal key', async () => {
    const response = await POST(new Request('http://test', {
      method: 'POST',
      body: JSON.stringify({ endpoint: 'transaction', idempotencyKey: 'terminal-key' }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(mocks.rearm).toHaveBeenCalledWith('session-book', 'transaction', 'terminal-key', 1);
  });
});
