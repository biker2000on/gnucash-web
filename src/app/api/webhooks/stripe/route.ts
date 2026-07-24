import { NextResponse } from 'next/server';
import { processStripeWebhook } from '@/lib/business/stripe-webhook';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const signature = request.headers.get('stripe-signature');
  if (!signature) return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  const rawBody = await request.text();
  const result = await processStripeWebhook(rawBody, signature);
  if (!result.accepted) {
    return NextResponse.json({ error: result.message ?? 'Invalid webhook' }, { status: 400 });
  }
  if (result.retry) {
    return NextResponse.json(
      { error: result.message ?? 'Payment posting is pending retry' },
      { status: 503 },
    );
  }
  return NextResponse.json({ received: true, duplicate: result.duplicate ?? false });
}
