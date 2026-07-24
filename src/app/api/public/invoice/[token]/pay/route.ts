import { NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { resolveActiveShareTarget } from '@/lib/business/invoice-shares.service';
import { getStripeConnection } from '@/lib/business/payment-connections';
import { getInvoiceWithStatus } from '@/lib/business/invoice-engine';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params;
    const target = await resolveActiveShareTarget(token);
    if (!target || target.estimateId !== null) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }
    const [connection, invoice] = await Promise.all([
      getStripeConnection(target.bookGuid),
      getInvoiceWithStatus(target.invoiceRef),
    ]);
    if (!connection || invoice.type !== 'invoice' || !invoice.posted || invoice.amountDue <= 0) {
      return NextResponse.json({ error: 'Online payment is not available' }, { status: 409 });
    }
    const origin = (process.env.NEXTAUTH_URL || new URL(request.url).origin).replace(/\/$/, '');
    const currency = await import('@/lib/prisma').then(async ({ default: prisma }) => {
      const row = await prisma.commodities.findUnique({
        where: { guid: invoice.currencyGuid },
        select: { mnemonic: true },
      });
      return (row?.mnemonic ?? 'USD').toLowerCase();
    });
    const body = new URLSearchParams();
    body.set('mode', 'payment');
    body.set('client_reference_id', invoice.guid);
    body.set('success_url', `${origin}/share/invoice/${token}?payment=success`);
    body.set('cancel_url', `${origin}/share/invoice/${token}?payment=cancelled`);
    body.set('line_items[0][quantity]', '1');
    body.set('line_items[0][price_data][currency]', currency);
    body.set('line_items[0][price_data][unit_amount]', String(Math.round(invoice.amountDue * 100)));
    body.set('line_items[0][price_data][product_data][name]', `Invoice ${invoice.id}`);
    body.set('metadata[book_guid]', target.bookGuid);
    body.set('metadata[invoice_guid]', invoice.guid);
    const shareKey = createHash('sha256').update(token).digest('hex').slice(0, 16);
    const idempotencyKey = `invoice-${invoice.guid}-${Math.round(invoice.amountDue * 100)}-${shareKey}`;

    const stripe = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connection.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': idempotencyKey,
      },
      body,
    });
    const data = await stripe.json().catch(() => null) as { url?: string; error?: { message?: string } } | null;
    if (!stripe.ok || !data?.url) {
      console.error('Stripe checkout session failed:', data?.error?.message ?? stripe.status);
      return NextResponse.json({ error: 'Unable to start payment' }, { status: 502 });
    }
    return NextResponse.json({ url: data.url }, {
      headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
    });
  } catch (error) {
    console.error('Public invoice payment error:', error);
    return NextResponse.json({ error: 'Unable to start payment' }, { status: 500 });
  }
}
