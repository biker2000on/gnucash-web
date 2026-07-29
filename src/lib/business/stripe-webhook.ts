import crypto from 'crypto';
import prisma from '@/lib/prisma';
import { query } from '@/lib/db';
import { fromDecimal, generateGuid } from '@/lib/gnucash';
import { applyPayment, getInvoiceWithStatus } from '@/lib/business/invoice-engine';
import { listStripeConnections, type StripeConnection } from '@/lib/business/payment-connections';
import { logAudit } from '@/lib/services/audit.service';
import { getAccountGuidsForBook } from '@/lib/book-scope';

const SIGNATURE_TOLERANCE_SECONDS = 300;

export function verifyStripeSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const parts = signatureHeader.split(',');
  const timestamp = parts.find(part => part.startsWith('t='))?.slice(2);
  const signatures = parts.filter(part => part.startsWith('v1=')).map(part => part.slice(3));
  if (!timestamp || signatures.length === 0) return false;
  const parsedTimestamp = Number(timestamp);
  if (!Number.isFinite(parsedTimestamp) || Math.abs(nowSeconds - parsedTimestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex');
  return signatures.some(signature => {
    if (!/^[0-9a-f]{64}$/.test(signature)) return false;
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  });
}

interface StripeEvent {
  id: string;
  type: string;
  data?: {
    object?: {
      id?: string;
      created?: number;
      amount_total?: number;
      amount_received?: number;
      currency?: string;
      payment_intent?: string;
      payment_status?: string;
      metadata?: Record<string, string>;
    };
  };
}

interface StripePaymentIntent {
  id: string;
  amount_received?: number;
  latest_charge?: {
    balance_transaction?: {
      fee?: number;
    };
  };
}

export function shouldPostStripeEvent(type: string, paymentStatus?: string): boolean {
  return type === 'checkout.session.async_payment_succeeded'
    || (type === 'checkout.session.completed' && paymentStatus === 'paid');
}

async function matchingConnection(
  rawBody: string,
  signature: string,
  bookGuid: string,
): Promise<StripeConnection | null> {
  for (const connection of await listStripeConnections()) {
    if (
      connection.bookGuid === bookGuid
      && verifyStripeSignature(rawBody, signature, connection.webhookSecret)
    ) {
      return connection;
    }
  }
  return null;
}

async function endCustomerGuid(invoiceGuid: string): Promise<string | null> {
  const invoice = await prisma.invoices.findUnique({
    where: { guid: invoiceGuid },
    select: { owner_type: true, owner_guid: true },
  });
  if (!invoice?.owner_guid) return null;
  if (invoice.owner_type === 2) return invoice.owner_guid;
  if (invoice.owner_type === 3) {
    const job = await prisma.jobs.findUnique({
      where: { guid: invoice.owner_guid },
      select: { owner_type: true, owner_guid: true },
    });
    return job?.owner_type === 2 ? job.owner_guid : null;
  }
  return null;
}

function stableTransactionGuid(kind: 'payment' | 'fee', eventId: string): string {
  return crypto.createHash('sha256').update(`stripe:${kind}:${eventId}`).digest('hex').slice(0, 32);
}

async function loadFee(connection: StripeConnection, paymentIntentId: string | undefined): Promise<number> {
  if (!paymentIntentId) throw new Error('Stripe payment intent is missing');
  const params = new URLSearchParams();
  params.append('expand[]', 'latest_charge.balance_transaction');
  const response = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}?${params}`, {
    headers: { Authorization: `Bearer ${connection.secretKey}` },
  });
  if (!response.ok) throw new Error(`Stripe fee lookup failed (${response.status})`);
  const intent = await response.json() as StripePaymentIntent;
  const fee = intent.latest_charge?.balance_transaction?.fee;
  if (fee === undefined) throw new Error('Stripe fee is not available yet');
  return Math.max(0, Number(fee) / 100);
}

async function createFeeTransaction(input: {
  connection: StripeConnection;
  invoiceGuid: string;
  eventId: string;
  fee: number;
  currencyGuid: string;
  date: Date;
}): Promise<string | null> {
  if (!(input.fee > 0) || !input.connection.feeAccountGuid) return null;
  const guid = stableTransactionGuid('fee', input.eventId);
  const existing = await prisma.transactions.findUnique({ where: { guid }, select: { guid: true } });
  if (existing) return existing.guid;
  const debit = fromDecimal(input.fee);
  const credit = fromDecimal(-input.fee);
  await prisma.$transaction(async tx => {
    await tx.transactions.create({
      data: {
        guid,
        currency_guid: input.currencyGuid,
        num: '',
        post_date: input.date,
        enter_date: new Date(),
        description: 'Stripe processing fee',
      },
    });
    await tx.splits.createMany({
      data: [
        {
          guid: generateGuid(),
          tx_guid: guid,
          account_guid: input.connection.feeAccountGuid!,
          memo: `Stripe event ${input.eventId}`,
          action: 'Fee',
          reconcile_state: 'n',
          reconcile_date: null,
          value_num: debit.num,
          value_denom: debit.denom,
          quantity_num: debit.num,
          quantity_denom: debit.denom,
          lot_guid: null,
        },
        {
          guid: generateGuid(),
          tx_guid: guid,
          account_guid: input.connection.transferAccountGuid,
          memo: `Stripe fee for invoice ${input.invoiceGuid}`,
          action: 'Fee',
          reconcile_state: 'n',
          reconcile_date: null,
          value_num: credit.num,
          value_denom: credit.denom,
          quantity_num: credit.num,
          quantity_denom: credit.denom,
          lot_guid: null,
        },
      ],
    });
    await tx.slots.createMany({
      data: [
        { obj_guid: guid, name: 'gnucash-web/payment-event', slot_type: 4, string_val: input.eventId },
        { obj_guid: guid, name: 'gnucash-web/invoice-guid', slot_type: 4, string_val: input.invoiceGuid },
      ],
    });
  });
  return guid;
}

export async function processStripeWebhook(
  rawBody: string,
  signatureHeader: string,
): Promise<{ accepted: boolean; duplicate?: boolean; message?: string; retry?: boolean }> {
  if (Buffer.byteLength(rawBody, 'utf8') > 1_000_000) {
    return { accepted: false, message: 'Webhook payload is too large' };
  }
  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return { accepted: false, message: 'Invalid JSON' };
  }
  if (!event.id || !event.type) return { accepted: false, message: 'Malformed event' };

  const object = event.data?.object;
  const invoiceGuid = object?.metadata?.invoice_guid ?? null;
  const bookGuid = object?.metadata?.book_guid ?? null;
  if (!bookGuid) {
    return { accepted: false, message: 'Book metadata is required' };
  }
  const connection = await matchingConnection(rawBody, signatureHeader, bookGuid);
  if (!connection) {
    return { accepted: false, message: 'Invalid signature or book metadata' };
  }
  const inserted = await query(
    `INSERT INTO gnucash_web_payment_events
      (book_guid, provider, provider_event_id, provider_payment_id, invoice_guid,
       status, amount, currency, payload)
     VALUES ($1,'stripe',$2,$3,$4,'processing',$5,$6,$7::jsonb)
     ON CONFLICT (provider, provider_event_id) DO NOTHING
     RETURNING id`,
    [
      connection.bookGuid,
      event.id,
      object?.payment_intent ?? object?.id ?? null,
      invoiceGuid,
      Number(object?.amount_total ?? object?.amount_received ?? 0) / 100,
      object?.currency?.toUpperCase() ?? null,
      rawBody,
    ],
  );
  if (!inserted.rows[0]) {
    const reclaimed = await query(
      `UPDATE gnucash_web_payment_events
          SET status = 'processing', error_message = NULL, received_at = NOW()
        WHERE provider = 'stripe' AND provider_event_id = $1
          AND (
            status = 'payment_posted'
            OR (status = 'failed' AND error_message IS NOT NULL)
            OR (status = 'processing' AND received_at < NOW() - INTERVAL '5 minutes')
          )
        RETURNING id`,
      [event.id],
    );
    if (!reclaimed.rows[0]) return { accepted: true, duplicate: true };
  }

  if (event.type.includes('payment_failed') || event.type === 'checkout.session.async_payment_failed') {
    await query(
      `UPDATE gnucash_web_payment_events SET status = 'failed', processed_at = NOW()
       WHERE provider = 'stripe' AND provider_event_id = $1`,
      [event.id],
    );
    return { accepted: true };
  }
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    await query(
      `UPDATE gnucash_web_payment_events SET status = 'ignored', processed_at = NOW()
       WHERE provider = 'stripe' AND provider_event_id = $1`,
      [event.id],
    );
    return { accepted: true };
  }
  if (!shouldPostStripeEvent(event.type, object?.payment_status)) {
    await query(
      `UPDATE gnucash_web_payment_events SET status = 'pending', processed_at = NOW()
       WHERE provider = 'stripe' AND provider_event_id = $1`,
      [event.id],
    );
    return { accepted: true };
  }
  if (!invoiceGuid || !/^[0-9a-f]{32}$/.test(invoiceGuid)) {
    await query(
      `UPDATE gnucash_web_payment_events SET status = 'failed', error_message = $1, processed_at = NOW()
       WHERE provider = 'stripe' AND provider_event_id = $2`,
      ['Missing invoice metadata', event.id],
    );
    return { accepted: true, message: 'Missing invoice metadata' };
  }

  try {
    const [invoice, accountGuids] = await Promise.all([
      getInvoiceWithStatus(invoiceGuid),
      getAccountGuidsForBook(connection.bookGuid),
    ]);
    const scopedAccounts = new Set(accountGuids);
    if (
      !invoice.postAccountGuid
      || !scopedAccounts.has(invoice.postAccountGuid)
      || !scopedAccounts.has(connection.transferAccountGuid)
      || (connection.feeAccountGuid && !scopedAccounts.has(connection.feeAccountGuid))
    ) {
      throw new Error('Invoice or payment account is outside the signing connection book');
    }
    const customerGuid = await endCustomerGuid(invoiceGuid);
    if (invoice.type !== 'invoice' || !customerGuid) throw new Error('Invoice customer not found');
    const amount = Number(object?.amount_total ?? object?.amount_received ?? 0) / 100;
    if (!(amount > 0)) throw new Error('Payment amount is missing');
    const date = new Date((object?.created ?? Math.floor(Date.now() / 1000)) * 1000);
    const dateIso = date.toISOString().slice(0, 10);
    const paymentTransactionGuid = stableTransactionGuid('payment', event.id);
    const payment = await applyPayment({
      ownerType: 'customer',
      ownerGuid: customerGuid,
      transferAccountGuid: connection.transferAccountGuid,
      amount,
      date: dateIso,
      num: object?.payment_intent ?? object?.id,
      memo: `Stripe ${event.id}`,
      allocations: [{ invoiceGuid, amount }],
      transactionGuid: paymentTransactionGuid,
    });
    const linked = await prisma.slots.findFirst({
      where: { obj_guid: payment.transactionGuid, name: 'gnucash-web/payment-event', string_val: event.id },
      select: { id: true },
    });
    if (!linked) {
      await prisma.slots.createMany({
        data: [
          { obj_guid: payment.transactionGuid, name: 'gnucash-web/payment-event', slot_type: 4, string_val: event.id },
          { obj_guid: payment.transactionGuid, name: 'gnucash-web/invoice-guid', slot_type: 4, string_val: invoiceGuid },
        ],
      });
    }
    await query(
      `UPDATE gnucash_web_payment_events
          SET status = 'payment_posted', amount = $1,
              payment_transaction_guid = $2, processed_at = NOW()
        WHERE provider = 'stripe' AND provider_event_id = $3`,
      [amount, payment.transactionGuid, event.id],
    );
    const fee = await loadFee(connection, object?.payment_intent);
    const feeTransactionGuid = await createFeeTransaction({
      connection,
      invoiceGuid,
      eventId: event.id,
      fee,
      currencyGuid: invoice.currencyGuid,
      date,
    });
    await query(
      `UPDATE gnucash_web_payment_events
       SET status = 'cleared', amount = $1, fee = $2,
           payment_transaction_guid = $3, fee_transaction_guid = $4,
           processed_at = NOW()
       WHERE provider = 'stripe' AND provider_event_id = $5`,
      [amount, fee, payment.transactionGuid, feeTransactionGuid, event.id],
    );
    await logAudit('CREATE', 'PAYMENT', payment.transactionGuid, null, {
      provider: 'stripe',
      eventId: event.id,
      invoiceGuid,
      amount,
      fee,
      feeTransactionGuid,
    }, { bookGuid: connection.bookGuid, userId: null });
    return { accepted: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Payment posting failed';
    const paymentTransactionGuid = stableTransactionGuid('payment', event.id);
    const paymentExists = await prisma.transactions.findUnique({
      where: { guid: paymentTransactionGuid },
      select: { guid: true },
    });
    await query(
      `UPDATE gnucash_web_payment_events
       SET status = $1, error_message = $2,
           payment_transaction_guid = COALESCE(payment_transaction_guid, $3),
           processed_at = NOW()
       WHERE provider = 'stripe' AND provider_event_id = $4`,
      [paymentExists ? 'payment_posted' : 'failed', message, paymentExists?.guid ?? null, event.id],
    );
    return { accepted: true, message, retry: true };
  }
}
