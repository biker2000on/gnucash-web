import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class SupersededError extends Error {}
  return {
    SupersededError,
    claim: vi.fn(), lock: vi.fn(), complete: vi.fn(), release: vi.fn(),
    transactionCreate: vi.fn(), splitsCreateMany: vi.fn(), recordPayment: vi.fn(),
    requireRole: vi.fn(),
  };
});

vi.mock('@/lib/prisma', () => ({
  default: {
    books: { findUnique: vi.fn() },
    accounts: { findUnique: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(async (callback) => callback({
      transactions: { create: mocks.transactionCreate },
      splits: { createMany: mocks.splitsCreateMany },
    })),
  },
}));
vi.mock('@/lib/auth', () => ({ requireRole: mocks.requireRole }));
vi.mock('@/lib/gnucash', () => ({ generateGuid: vi.fn(() => 'a'.repeat(32)) }));
vi.mock('@/lib/book-scope', () => ({ getAccountGuidsForBook: vi.fn(async () => ['from', 'to']) }));
vi.mock('@/lib/services/period-lock.service', () => ({ withPeriodLockCheck: vi.fn(async () => null) }));
vi.mock('@/lib/cache', () => ({ cacheInvalidateFrom: vi.fn(async () => undefined) }));
vi.mock('@/lib/data-events', () => ({ publishDataChange: vi.fn() }));
vi.mock('@/lib/services/audit.service', () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/inbound-webhooks', () => ({
  inboundTransactionSchema: {}, inboundMembershipPaymentSchema: {},
  parseInbound: vi.fn((_schema, body) => ({ ok: true, data: body })),
  toCents: vi.fn(() => 100),
}));
vi.mock('@/lib/services/membership.service', () => ({
  recordPayment: mocks.recordPayment,
  MembershipValidationError: class MembershipValidationError extends Error {},
}));
vi.mock('@/lib/webhook-idempotency', () => ({
  claimWebhookIdempotency: mocks.claim,
  lockWebhookIdempotencyAttempt: mocks.lock,
  completeWebhookIdempotency: mocks.complete,
  releaseWebhookIdempotency: mocks.release,
  readIdempotencyKey: (header: string | null, body: { idempotencyKey?: string }) => header ?? body.idempotencyKey ?? null,
  validateIdempotencyKey: (key: string | null) => ({ ok: true, key }),
  WebhookClaimSupersededError: mocks.SupersededError,
}));

import prisma from '@/lib/prisma';
import { POST as postTransaction } from '../transaction/route';
import { POST as postMembershipPayment } from '../membership-payment/route';

let txClient: unknown;

const transactionBody = {
  date: '2026-08-17', description: 'Fence test', amount: 1,
  fromAccountGuid: 'from', toAccountGuid: 'to', idempotencyKey: 'fence-key',
};
const membershipBody = {
  memberId: 1, paidDate: '2026-08-17', amount: 10, method: 'cash', idempotencyKey: 'fence-key',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue({ bookGuid: 'book-from-session', user: { id: 1 } });
  mocks.claim.mockResolvedValue({ status: 'claimed', attempt: 1 });
  mocks.lock.mockResolvedValue(undefined);
  mocks.complete.mockResolvedValue(true);
  mocks.release.mockResolvedValue(undefined);
  mocks.transactionCreate.mockResolvedValue({});
  mocks.splitsCreateMany.mockResolvedValue({ count: 2 });
  mocks.recordPayment.mockResolvedValue({ paymentId: 1 });
  vi.mocked(prisma.$transaction).mockImplementation(async (callback) => {
    txClient = {
      transactions: { create: mocks.transactionCreate },
      splits: { createMany: mocks.splitsCreateMany },
    };
    return callback(txClient as never);
  });
  vi.mocked(prisma.books.findUnique).mockResolvedValue({ root_account_guid: 'root' } as never);
  vi.mocked(prisma.accounts.findUnique).mockResolvedValue({ commodity_guid: 'usd' } as never);
  vi.mocked(prisma.accounts.findMany).mockResolvedValue([
    { guid: 'from', name: 'From', commodity_guid: 'usd', commodity_scu: 100, placeholder: 0 },
    { guid: 'to', name: 'To', commodity_guid: 'usd', commodity_scu: 100, placeholder: 0 },
  ] as never);
});

// PostgreSQL integration tests prove actual blocking. These no-DB tests pin
// the lock-before-write route shape in CI until the Postgres harness runs it.
describe('inbound webhook idempotency fence', () => {
  it('locks before any transaction domain write', async () => {
    const events: string[] = [];
    mocks.lock.mockImplementation(async () => { events.push('lock'); });
    mocks.transactionCreate.mockImplementation(async () => { events.push('transaction'); return {}; });

    const response = await postTransaction(new Request('http://test', {
      method: 'POST', body: JSON.stringify(transactionBody),
    }));

    expect(response.status).toBe(201);
    expect(mocks.lock).toHaveBeenCalledWith('book-from-session', 'transaction', 'fence-key', 1, txClient);
    expect(mocks.complete.mock.calls[0]?.[5]).toBe(txClient);
    expect(events).toEqual(['lock', 'transaction']);
  });

  it('locks before any membership domain write', async () => {
    const events: string[] = [];
    mocks.lock.mockImplementation(async () => { events.push('lock'); });
    mocks.recordPayment.mockImplementation(async () => { events.push('payment'); return { paymentId: 1 }; });

    const response = await postMembershipPayment(new Request('http://test', {
      method: 'POST', body: JSON.stringify(membershipBody),
    }));

    expect(response.status).toBe(201);
    expect(mocks.lock).toHaveBeenCalledWith('book-from-session', 'membership-payment', 'fence-key', 1, txClient);
    expect(mocks.complete.mock.calls[0]?.[5]).toBe(txClient);
    expect(events).toEqual(['lock', 'payment']);
  });

  it('returns 409 without a domain write when the fence is superseded', async () => {
    mocks.lock.mockRejectedValue(new mocks.SupersededError());

    const response = await postTransaction(new Request('http://test', {
      method: 'POST', body: JSON.stringify(transactionBody),
    }));

    expect(response.status).toBe(409);
    expect(mocks.transactionCreate).not.toHaveBeenCalled();
    expect(mocks.splitsCreateMany).not.toHaveBeenCalled();
  });

  it('returns retryable 500, not 409, when completion throws', async () => {
    mocks.complete.mockRejectedValue(new Error('connection reset'));

    const response = await postTransaction(new Request('http://test', {
      method: 'POST', body: JSON.stringify(transactionBody),
    }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to create transaction' });
    expect(mocks.release).toHaveBeenCalledWith('book-from-session', 'transaction', 'fence-key', 1);
  });
});
