'use client';

import { useState } from 'react';
import type { PublicShareView } from '@/lib/business/invoice-shares.service';

export function PublicPortalActions({ token, view }: { token: string; view: PublicShareView }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const pay = async () => {
    setBusy('pay');
    setMessage(null);
    try {
      const res = await fetch(`/api/public/invoice/${token}/pay`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.url) throw new Error(data?.error || 'Unable to start payment');
      window.location.assign(data.url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to start payment');
      setBusy(null);
    }
  };

  const respond = async (decision: 'accepted' | 'declined') => {
    setBusy(decision);
    setMessage(null);
    try {
      const res = await fetch(`/api/public/invoice/${token}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Unable to record response');
      setMessage(decision === 'accepted' ? 'Estimate accepted. Thank you.' : 'Estimate declined.');
      window.setTimeout(() => window.location.reload(), 700);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to record response');
    } finally {
      setBusy(null);
    }
  };

  if (view.type === 'invoice') {
    if (!view.paymentEnabled && view.payments.length === 0) return null;
    return (
      <section className="mt-4 rounded-lg border border-border bg-surface p-5 print:hidden">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-foreground">Payment portal</h2>
            <p className="mt-1 text-sm text-foreground-secondary">
              {view.amountDue > 0 ? `${view.amountDue.toFixed(2)} ${view.currency} remaining.` : 'This invoice is paid.'}
            </p>
          </div>
          {view.paymentEnabled && (
            <button type="button" onClick={() => void pay()} disabled={busy === 'pay'} className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">
              {busy === 'pay' ? 'Opening secure checkout…' : 'Pay now'}
            </button>
          )}
        </div>
        {view.payments.length > 0 && (
          <div className="mt-4 border-t border-border pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-muted">Payment history</p>
            <div className="mt-2 space-y-2">
              {view.payments.map(payment => (
                <div key={payment.id} className="flex items-center justify-between text-sm">
                  <span className="text-foreground-secondary">
                    {new Date(payment.date).toLocaleDateString()} · <span className="capitalize">{payment.status}</span>
                  </span>
                  <span className="font-mono text-foreground">{payment.amount.toFixed(2)} {view.currency}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {message && <p className="mt-3 text-sm text-negative">{message}</p>}
      </section>
    );
  }

  if (!view.canRespond) return null;
  return (
    <section className="mt-4 rounded-lg border border-border bg-surface p-5 print:hidden">
      <h2 className="font-semibold text-foreground">Respond to estimate</h2>
      <p className="mt-1 text-sm text-foreground-secondary">Your response is recorded on the shared estimate.</p>
      <div className="mt-4 flex gap-2">
        <button type="button" onClick={() => void respond('accepted')} disabled={Boolean(busy)} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">
          {busy === 'accepted' ? 'Accepting…' : 'Accept estimate'}
        </button>
        <button type="button" onClick={() => void respond('declined')} disabled={Boolean(busy)} className="rounded-lg border border-negative/30 px-4 py-2 text-sm font-medium text-negative disabled:opacity-50">
          {busy === 'declined' ? 'Declining…' : 'Decline'}
        </button>
      </div>
      {message && <p className="mt-3 text-sm text-foreground-secondary">{message}</p>}
    </section>
  );
}
