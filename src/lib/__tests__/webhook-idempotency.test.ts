import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  raw: vi.fn(),
  executeRaw: vi.fn(),
  executeRawUnsafe: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    $queryRaw: mocks.raw,
    $executeRaw: mocks.executeRaw,
    $executeRawUnsafe: mocks.executeRawUnsafe,
  },
}));

import {
  claimWebhookIdempotency,
  completeWebhookIdempotency,
  readIdempotencyKey,
  releaseWebhookIdempotency,
  validateIdempotencyKey,
  IDEMPOTENCY_KEY_MAX_LENGTH,
} from '../webhook-idempotency';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeRawUnsafe.mockResolvedValue(0);
  mocks.executeRaw.mockResolvedValue(1);
});

describe('readIdempotencyKey', () => {
  it('prefers the Idempotency-Key header', () => {
    expect(readIdempotencyKey('from-header', { idempotencyKey: 'from-body' })).toBe('from-header');
  });

  it('falls back to the body field', () => {
    expect(readIdempotencyKey(null, { idempotencyKey: 'from-body' })).toBe('from-body');
  });

  it('returns null when neither is present', () => {
    expect(readIdempotencyKey(null, { date: '2026-08-01' })).toBeNull();
    expect(readIdempotencyKey(null, null)).toBeNull();
  });
});

describe('validateIdempotencyKey', () => {
  it('treats an absent key as opt-out, not an error', () => {
    expect(validateIdempotencyKey(null)).toEqual({ ok: true, key: null });
    expect(validateIdempotencyKey(undefined)).toEqual({ ok: true, key: null });
  });

  it('trims and accepts a normal key', () => {
    expect(validateIdempotencyKey('  n8n-run-42  ')).toEqual({ ok: true, key: 'n8n-run-42' });
  });

  it('rejects non-strings, blanks and over-long keys', () => {
    expect(validateIdempotencyKey(42).ok).toBe(false);
    expect(validateIdempotencyKey('   ').ok).toBe(false);
    expect(validateIdempotencyKey('x'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1)).ok).toBe(false);
    // Exactly at the limit is fine.
    expect(validateIdempotencyKey('x'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH)).ok).toBe(true);
  });
});

describe('claimWebhookIdempotency', () => {
  it('claims via INSERT ... ON CONFLICT DO NOTHING so the DB picks the winner', async () => {
    mocks.raw.mockResolvedValueOnce([{ id: 1 }]);

    await expect(claimWebhookIdempotency('book-1', 'transaction', 'k1'))
      .resolves.toEqual({ status: 'claimed' });

    const sql = String(mocks.raw.mock.calls[0][0]);
    expect(sql).toContain('INSERT INTO gnucash_web_webhook_idempotency');
    expect(sql).toContain('ON CONFLICT (book_guid, endpoint, idempotency_key) DO NOTHING');
    expect(sql).toContain('RETURNING id');
  });

  it('reports a replay with the original result when the key was already used', async () => {
    mocks.raw
      .mockResolvedValueOnce([]) // conflict: no row inserted
      .mockResolvedValueOnce([{ result: { success: true, transactionGuid: 'abc' } }]);

    await expect(claimWebhookIdempotency('book-1', 'transaction', 'k1')).resolves.toEqual({
      status: 'replay',
      result: { success: true, transactionGuid: 'abc' },
    });
  });

  it('reports a replay with a null result while the original is still in flight', async () => {
    mocks.raw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ result: null }]);

    await expect(claimWebhookIdempotency('book-1', 'membership-payment', 'k9')).resolves.toEqual({
      status: 'replay',
      result: null,
    });
  });

  it('namespaces keys per endpoint', async () => {
    mocks.raw.mockResolvedValue([{ id: 1 }]);
    await claimWebhookIdempotency('book-1', 'membership-payment', 'k1');
    expect(mocks.raw.mock.calls[0]).toContain('membership-payment');
  });
});

describe('claim lifecycle', () => {
  it('records the response so a later replay can return it', async () => {
    await completeWebhookIdempotency('book-1', 'transaction', 'k1', { success: true });
    const call = mocks.executeRaw.mock.calls[0];
    expect(String(call[0])).toContain('UPDATE gnucash_web_webhook_idempotency');
    expect(call).toContain(JSON.stringify({ success: true }));
  });

  it('releases only uncompleted claims, so a failure never burns the key', async () => {
    await releaseWebhookIdempotency('book-1', 'transaction', 'k1');
    const sql = String(mocks.executeRaw.mock.calls[0][0]);
    expect(sql).toContain('DELETE FROM gnucash_web_webhook_idempotency');
    expect(sql).toContain('completed_at IS NULL');
  });

  it('never throws out of complete/release — the ledger write already succeeded', async () => {
    mocks.executeRaw.mockRejectedValue(new Error('connection reset'));
    await expect(completeWebhookIdempotency('b', 'transaction', 'k', {})).resolves.toBeUndefined();
    await expect(releaseWebhookIdempotency('b', 'transaction', 'k')).resolves.toBeUndefined();
  });
});
