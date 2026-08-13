/**
 * Regression: POST /api/business/payments dropped the client-supplied
 * `transactionGuid` when building the applyPayment input, even though the
 * engine implements idempotency on it. A retried $40 payment therefore posted
 * twice ($80 against a $100 invoice).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), applyPayment: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireRole: mocks.auth }));
vi.mock('@/lib/business/invoice-engine', () => ({
  applyPayment: mocks.applyPayment,
  listPayments: vi.fn(),
}));
vi.mock('@/lib/business/api-errors', () => ({
  mapInvoiceError: (e: unknown) => {
    throw e;
  },
}));
vi.mock('@/lib/cache', () => ({ cacheInvalidateAllForBook: vi.fn() }));
vi.mock('@/lib/data-events', () => ({ publishDataChange: vi.fn() }));

import { POST } from './route';

const request = (body: unknown) =>
  ({ json: vi.fn().mockResolvedValue(body) }) as unknown as import('next/server').NextRequest;

const payment = (overrides: Record<string, unknown> = {}) => ({
  ownerType: 'customer',
  ownerGuid: 'cust0000000000000000000000000001',
  transferAccountGuid: 'acct0000000000000000000000000001',
  amount: 40,
  date: '2026-08-12',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ bookGuid: 'book-1', user: { id: 1 }, role: 'edit' });
  mocks.applyPayment.mockResolvedValue({
    transactionGuid: 'tx000000000000000000000000000001',
    allocations: [],
    fullyPaidInvoiceGuids: [],
  });
});

describe('POST /api/business/payments', () => {
  it('forwards the client idempotency key to applyPayment', async () => {
    const res = await POST(request(payment({ transactionGuid: 'tx000000000000000000000000000001' })));

    expect(res.status).toBe(201);
    expect(mocks.applyPayment).toHaveBeenCalledWith(
      'book-1',
      expect.objectContaining({ transactionGuid: 'tx000000000000000000000000000001' }),
    );
  });

  it('leaves transactionGuid undefined when the client does not send one', async () => {
    await POST(request(payment()));
    expect(mocks.applyPayment.mock.calls[0][1].transactionGuid).toBeUndefined();
  });

  it('rejects a non-string transactionGuid', async () => {
    const res = await POST(request(payment({ transactionGuid: 42 })));
    expect(res.status).toBe(400);
    expect(mocks.applyPayment).not.toHaveBeenCalled();
  });

  it('does not double-post a replayed payment against a $100 invoice', async () => {
    // Stand-in for the engine's idempotency check (invoice-engine.ts:1377):
    // a repeat of a known transactionGuid returns the existing payment.
    const posted = new Map<string, number>();
    let appliedTotal = 0;
    mocks.applyPayment.mockImplementation(async (_book: string, input: { amount: number; transactionGuid?: string }) => {
      if (input.transactionGuid && posted.has(input.transactionGuid)) {
        return { transactionGuid: input.transactionGuid, allocations: [], fullyPaidInvoiceGuids: [] };
      }
      const guid = input.transactionGuid ?? `generated-${posted.size}`;
      posted.set(guid, input.amount);
      appliedTotal += input.amount;
      return { transactionGuid: guid, allocations: [], fullyPaidInvoiceGuids: [] };
    });

    const body = payment({ transactionGuid: 'tx000000000000000000000000000001' });
    await POST(request(body));
    await POST(request(body)); // user retried after a timeout

    expect(posted.size).toBe(1);
    expect(appliedTotal).toBe(40); // not 80
  });
});
