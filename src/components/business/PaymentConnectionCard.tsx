'use client';

import { useEffect, useState } from 'react';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { useToast } from '@/contexts/ToastContext';

interface ConnectionView {
  enabled: boolean;
  hasSecretKey: boolean;
  hasWebhookSecret: boolean;
  transferAccountGuid: string | null;
  feeAccountGuid: string | null;
}

export function PaymentConnectionCard() {
  const { success, error } = useToast();
  const [connection, setConnection] = useState<ConnectionView | null>(null);
  const [secretKey, setSecretKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [transferAccountGuid, setTransferAccountGuid] = useState('');
  const [feeAccountGuid, setFeeAccountGuid] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    fetch('/api/business/payment-connection')
      .then(async res => {
        if (res.status === 403) {
          setUnavailable(true);
          return null;
        }
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Failed to load payment connection');
        return data.connection as ConnectionView;
      })
      .then(value => {
        if (!value) return;
        setConnection(value);
        setTransferAccountGuid(value.transferAccountGuid ?? '');
        setFeeAccountGuid(value.feeAccountGuid ?? '');
        setEnabled(value.enabled);
      })
      .catch(err => error(err instanceof Error ? err.message : 'Failed to load payment connection'));
  }, [error]);

  if (unavailable) return null;

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/business/payment-connection', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secretKey: secretKey || null,
          webhookSecret: webhookSecret || null,
          transferAccountGuid: transferAccountGuid || null,
          feeAccountGuid: feeAccountGuid || null,
          enabled,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Failed to save payment connection');
      setConnection(data.connection);
      setSecretKey('');
      setWebhookSecret('');
      success('Stripe payment connection saved');
    } catch (err) {
      error(err instanceof Error ? err.message : 'Failed to save payment connection');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Invoice Payments</h2>
          <p className="mt-1 text-sm text-foreground-secondary">
            Stripe Checkout on public invoices, with signed webhook posting for payments and fees.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-foreground-secondary">
          <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
          Enable Pay now
        </label>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-foreground-secondary">Stripe secret key</label>
          <input
            type="password"
            value={secretKey}
            onChange={event => setSecretKey(event.target.value)}
            placeholder={connection?.hasSecretKey ? 'Stored · enter to replace' : 'sk_live_… or sk_test_…'}
            autoComplete="off"
            className="w-full rounded-lg border border-border bg-input-bg px-3 py-2 text-sm text-foreground"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-foreground-secondary">Webhook signing secret</label>
          <input
            type="password"
            value={webhookSecret}
            onChange={event => setWebhookSecret(event.target.value)}
            placeholder={connection?.hasWebhookSecret ? 'Stored · enter to replace' : 'whsec_…'}
            autoComplete="off"
            className="w-full rounded-lg border border-border bg-input-bg px-3 py-2 text-sm text-foreground"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-foreground-secondary">Processor clearing / deposit account</label>
          <AccountSelector
            value={transferAccountGuid}
            onChange={guid => setTransferAccountGuid(guid)}
            accountTypes={['BANK', 'CASH', 'ASSET']}
            placeholder="Select Stripe clearing account…"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-foreground-secondary">Processor fee expense account</label>
          <AccountSelector
            value={feeAccountGuid}
            onChange={guid => setFeeAccountGuid(guid)}
            accountTypes={['EXPENSE']}
            placeholder="Select fee account…"
          />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-xs text-foreground-muted">
          Webhook URL: <span className="font-mono">/api/webhooks/stripe</span>. Credentials are encrypted at rest.
        </p>
        <button type="button" onClick={() => void save()} disabled={saving} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">
          {saving ? 'Saving…' : 'Save payment connection'}
        </button>
      </div>
    </section>
  );
}
