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
  listWebhookIdempotencyAttention,
  readIdempotencyKey,
  rearmWebhookIdempotency,
  releaseWebhookIdempotency,
  validateIdempotencyKey,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  WEBHOOK_CLAIM_STALE_MINUTES,
  WEBHOOK_MAX_ATTEMPTS,
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
      .resolves.toEqual({ status: 'claimed', attempt: 1 });

    const sql = String(mocks.raw.mock.calls[0][0]);
    expect(sql).toContain('INSERT INTO gnucash_web_webhook_idempotency');
    expect(sql).toContain('ON CONFLICT (book_guid, endpoint, idempotency_key) DO UPDATE SET');
    expect(sql).toContain('RETURNING attempts');
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

  it('reclaims a crash-left stale claim so its redelivery is processed, not dropped', async () => {
    // This is intentionally SQL-predicate proof, not a stateful fake that
    // could implement the timeout rule itself. Postgres receives the stale
    // condition, bounded budget, and atomic ON CONFLICT reclaim in one query.
    mocks.raw.mockResolvedValueOnce([{ attempts: 2 }]);

    await expect(claimWebhookIdempotency('book-1', 'transaction', 'crashed-k'))
      .resolves.toEqual({ status: 'claimed', attempt: 2 });

    const sql = String(mocks.raw.mock.calls[0][0]);
    expect(sql).toContain("state = 'processing'");
    expect(sql).toContain('claim_started_at');
    expect(sql).toContain('attempts <');
    expect(mocks.raw.mock.calls[0]).toContain(WEBHOOK_CLAIM_STALE_MINUTES);
    expect(mocks.raw.mock.calls[0]).toContain(WEBHOOK_MAX_ATTEMPTS);
  });

  it('keeps a genuinely completed event deduplicated on redelivery', async () => {
    mocks.raw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ result: { success: true }, state: 'completed', attempts: 1 }]);

    await expect(claimWebhookIdempotency('book-1', 'transaction', 'done-k')).resolves.toEqual({
      status: 'replay', result: { success: true },
    });

    const claimSql = String(mocks.raw.mock.calls[0][0]);
    expect(claimSql).toContain('result IS NULL');
  });

  it('bounds repeated write failures and exposes the terminal record instead of re-listing it', async () => {
    await releaseWebhookIdempotency('book-1', 'transaction', 'poison-k', WEBHOOK_MAX_ATTEMPTS);
    const releaseSql = String(mocks.executeRaw.mock.calls[0][0]);
    expect(releaseSql).toContain("THEN 'failed_permanent'");
    expect(releaseSql).toContain('attempts >=');
    expect(mocks.executeRaw.mock.calls[0]).toContain(WEBHOOK_MAX_ATTEMPTS);

    mocks.raw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        result: null, state: 'failed_permanent', attempts: WEBHOOK_MAX_ATTEMPTS,
        detail: 'retry budget exhausted', claim_started_at: new Date(),
      }]);
    await expect(claimWebhookIdempotency('book-1', 'transaction', 'poison-k'))
      .resolves.toEqual({
        status: 'terminal', state: 'failed_permanent', attempts: WEBHOOK_MAX_ATTEMPTS,
        detail: 'retry budget exhausted',
      });
    const claimSql = String(mocks.raw.mock.calls[0][0]);
    expect(claimSql).toContain('attempts <');
    expect(mocks.raw.mock.calls[0]).toContain(WEBHOOK_MAX_ATTEMPTS);

    mocks.raw.mockResolvedValueOnce([{
      endpoint: 'transaction', idempotency_key: 'poison-k', state: 'failed_permanent',
      attempts: WEBHOOK_MAX_ATTEMPTS, detail: 'retry budget exhausted', claim_started_at: new Date(),
    }]);
    await expect(listWebhookIdempotencyAttention('book-1')).resolves.toEqual([{
      endpoint: 'transaction', idempotencyKey: 'poison-k', state: 'failed_permanent',
      attempts: WEBHOOK_MAX_ATTEMPTS, detail: 'retry budget exhausted', claimStartedAt: expect.any(Date),
    }]);
    const attentionSql = String(mocks.raw.mock.calls[2][0]);
    expect(attentionSql).toContain("state = 'failed_permanent'");
    expect(attentionSql).toContain('attempts >=');
  });
});

describe('claim lifecycle', () => {
  it('records the response so a later replay can return it', async () => {
    await completeWebhookIdempotency('book-1', 'transaction', 'k1', 1, { success: true });
    const call = mocks.executeRaw.mock.calls[0];
    expect(String(call[0])).toContain('UPDATE gnucash_web_webhook_idempotency');
    expect(call).toContain(JSON.stringify({ success: true }));
  });

  it('releases only uncompleted claims, so a failure never burns the key', async () => {
    await releaseWebhookIdempotency('book-1', 'transaction', 'k1', 1);
    const sql = String(mocks.executeRaw.mock.calls[0][0]);
    expect(sql).toContain('UPDATE gnucash_web_webhook_idempotency');
    expect(sql).toContain("state = 'processing'");
    expect(sql).toContain('attempts =');
  });

  it('logs a completion rejected because a newer attempt owns the claim', async () => {
    mocks.executeRaw.mockResolvedValue(0);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(completeWebhookIdempotency('book-1', 'transaction', 'k1', 1, {}))
      .resolves.toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Rejected stale webhook completion'));
    error.mockRestore();
  });

  it('re-arms only an incomplete terminal record and resets its bounded budget once', async () => {
    mocks.executeRaw.mockResolvedValue(1);
    await expect(rearmWebhookIdempotency('book-1', 'transaction', 'poison-k', 42))
      .resolves.toBe(true);
    const sql = String(mocks.executeRaw.mock.calls[0][0]);
    expect(sql).toContain("SET state = 'failed', attempts = 0");
    expect(sql).toContain('result IS NULL');
    expect(sql).toContain("state IN ('failed_permanent', 'processing')");
    expect(sql).toContain('NOW()');
  });

  it('never throws out of complete/release — the ledger write already succeeded', async () => {
    mocks.executeRaw.mockRejectedValue(new Error('connection reset'));
    await expect(completeWebhookIdempotency('b', 'transaction', 'k', 1, {})).resolves.toBe(false);
    await expect(releaseWebhookIdempotency('b', 'transaction', 'k', 1)).resolves.toBeUndefined();
  });
});
