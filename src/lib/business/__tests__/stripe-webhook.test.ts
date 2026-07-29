import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { shouldPostStripeEvent, verifyStripeSignature } from '@/lib/business/stripe-webhook';

describe('verifyStripeSignature', () => {
  const secret = 'whsec_test_secret';
  const payload = '{"id":"evt_123","type":"checkout.session.completed"}';
  const timestamp = 1_700_000_000;

  function signature(body = payload, time = timestamp) {
    const digest = crypto.createHmac('sha256', secret).update(`${time}.${body}`).digest('hex');
    return `t=${time},v1=${digest}`;
  }

  it('accepts a valid signature within the replay window', () => {
    expect(verifyStripeSignature(payload, signature(), secret, timestamp + 120)).toBe(true);
  });

  it('rejects payload tampering', () => {
    expect(verifyStripeSignature(`${payload} `, signature(), secret, timestamp)).toBe(false);
  });

  it('rejects stale events', () => {
    expect(verifyStripeSignature(payload, signature(), secret, timestamp + 301)).toBe(false);
  });

  it('accepts any matching v1 signature during secret rotation', () => {
    expect(verifyStripeSignature(payload, `t=${timestamp},v1=${'0'.repeat(64)},${signature()}`, secret, timestamp)).toBe(true);
  });
});

describe('shouldPostStripeEvent', () => {
  it('posts completed sessions only after Stripe marks them paid', () => {
    expect(shouldPostStripeEvent('checkout.session.completed', 'paid')).toBe(true);
    expect(shouldPostStripeEvent('checkout.session.completed', 'unpaid')).toBe(false);
  });

  it('posts the asynchronous success event', () => {
    expect(shouldPostStripeEvent('checkout.session.async_payment_succeeded')).toBe(true);
  });
});
