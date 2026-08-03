/**
 * Stripe webhook — book scope (audit S5).
 *
 * The webhook runs with NO session, so it must never fall back to an "active"
 * book. The book it posts into is the one on the signature-verified Stripe
 * connection, and the engine only returns the invoice when that same book owns
 * it — so an invoice belonging to another book can never be paid here.
 */

import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */

const BOOK_A = 'a'.repeat(32);
const INVOICE = 'f'.repeat(32);
const CUSTOMER = 'c'.repeat(32);
const WEBHOOK_SECRET = 'whsec_book_scope';

const h = vi.hoisted(() => ({
  invoiceView: null as any,
  invoiceRow: null as any,
  auditBookGuids: [] as unknown[],
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    invoices: { findUnique: vi.fn(async () => h.invoiceRow) },
    transactions: { findUnique: vi.fn(async () => null) },
    slots: { findFirst: vi.fn(async () => null), createMany: vi.fn(async () => ({ count: 2 })) },
  },
}));

vi.mock('@/lib/db', () => ({ query: vi.fn(async () => ({ rows: [{ id: 1 }] })) }));

vi.mock('@/lib/business/payment-connections', () => ({
  listStripeConnections: vi.fn(async () => [
    {
      bookGuid: BOOK_A,
      webhookSecret: WEBHOOK_SECRET,
      secretKey: 'sk_test',
      transferAccountGuid: 'bank-a',
      feeAccountGuid: null,
      enabled: true,
    },
  ]),
}));

vi.mock('@/lib/book-scope', () => ({
  getAccountGuidsForBook: vi.fn(async () => ['ar-a', 'bank-a']),
}));

vi.mock('@/lib/services/audit.service', () => ({
  logAudit: vi.fn(async (_a, _b, _c, _d, _e, opts: any) => {
    h.auditBookGuids.push(opts?.bookGuid);
  }),
}));

vi.mock('@/lib/data-events', () => ({ afterLedgerWrite: vi.fn() }));

vi.mock('@/lib/business/invoice-engine', () => ({
  getInvoiceWithStatus: vi.fn(async () => h.invoiceView),
  applyPayment: vi.fn(async () => ({
    transactionGuid: 'txn-1',
    allocations: [],
    fullyPaidInvoiceGuids: [],
  })),
}));

import { processStripeWebhook } from '@/lib/business/stripe-webhook';
import { getInvoiceWithStatus, applyPayment } from '@/lib/business/invoice-engine';
import { query } from '@/lib/db';

function signedEvent(bookGuid: string) {
  const body = JSON.stringify({
    id: `evt_${Math.random().toString(16).slice(2)}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_1',
        created: 1_760_000_000,
        amount_total: 10_500,
        currency: 'usd',
        payment_intent: 'pi_1',
        payment_status: 'paid',
        metadata: { invoice_guid: INVOICE, book_guid: bookGuid },
      },
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return { body, signature: `t=${timestamp},v1=${digest}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auditBookGuids = [];
  h.invoiceRow = { owner_type: 2, owner_guid: CUSTOMER };
  h.invoiceView = {
    guid: INVOICE,
    type: 'invoice',
    posted: true,
    postAccountGuid: 'ar-a',
    currencyGuid: 'usd',
    amountDue: 105,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'pi_1', latest_charge: { balance_transaction: { fee: 0 } } }),
    })),
  );
});

describe('processStripeWebhook — book derivation', () => {
  it('posts against the book on the signed connection, not an ambient one', async () => {
    const { body, signature } = signedEvent(BOOK_A);
    const result = await processStripeWebhook(body, signature);

    expect(result).toMatchObject({ accepted: true });
    // The invoice is fetched AS the connection's book: a foreign invoice comes
    // back null instead of being paid.
    expect(getInvoiceWithStatus).toHaveBeenCalledWith(BOOK_A, INVOICE);
    expect(applyPayment).toHaveBeenCalledTimes(1);
    expect(vi.mocked(applyPayment).mock.calls[0][0]).toBe(BOOK_A);
    expect(vi.mocked(applyPayment).mock.calls[0][1]).toMatchObject({
      ownerType: 'customer',
      ownerGuid: CUSTOMER,
      allocations: [{ invoiceGuid: INVOICE, amount: 105 }],
    });
    expect(h.auditBookGuids).toEqual([BOOK_A]);
  });

  it('refuses to pay an invoice the connection book does not own', async () => {
    // What the engine returns for an invoice owned by another book.
    h.invoiceView = null;

    const { body, signature } = signedEvent(BOOK_A);
    const result = await processStripeWebhook(body, signature);

    expect(applyPayment).not.toHaveBeenCalled();
    expect(result.message).toMatch(/outside the signing connection book/);
    // The event is recorded as failed rather than silently dropped.
    const statuses = vi.mocked(query).mock.calls.map((c) => String(c[0]));
    expect(statuses.some((sql) => sql.includes("SET status = $1"))).toBe(true);
  });

  it('rejects a book_guid in the payload that no connection signs for', async () => {
    const { body, signature } = signedEvent('b'.repeat(32));
    const result = await processStripeWebhook(body, signature);

    expect(result).toMatchObject({ accepted: false });
    expect(getInvoiceWithStatus).not.toHaveBeenCalled();
    expect(applyPayment).not.toHaveBeenCalled();
  });
});
