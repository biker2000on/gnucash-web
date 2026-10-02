'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { readErrorBody } from '@/lib/api-error';

interface PortalLink {
  id: number;
  prefix: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  active: boolean;
}

const EXPIRY_OPTIONS = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
];

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

/**
 * Contractor portal links for one vendor: create (the URL is shown once —
 * only its hash is stored), copy, email to the vendor, revoke, and see when
 * the contractor last opened it.
 */
export function VendorPortalSection({ vendorGuid, canEdit }: { vendorGuid: string; canEdit: boolean }) {
  const { success, error: showError } = useToast();
  const [links, setLinks] = useState<PortalLink[] | null>(null);
  const [emailConfigured, setEmailConfigured] = useState(false);
  const [vendorEmail, setVendorEmail] = useState<string | null>(null);
  const [expiry, setExpiry] = useState(180);
  const [fresh, setFresh] = useState<{ url: string; emailed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/business/vendors/${vendorGuid}/portal`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setLinks(data.links ?? []);
        setEmailConfigured(Boolean(data.emailConfigured));
        setVendorEmail(data.vendorEmail ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [vendorGuid, reloadKey]);

  const create = async (emailInvite: boolean) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/business/vendors/${vendorGuid}/portal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresInDays: expiry, emailInvite }),
      });
      if (!res.ok) throw new Error(await readErrorBody(res, 'Could not create the link'));
      const data = (await res.json()) as { url: string; emailed: boolean };
      setFresh(data);
      try {
        await navigator.clipboard.writeText(data.url);
      } catch {
        /* clipboard may be unavailable; the URL is shown below */
      }
      success(data.emailed ? `Link emailed to ${vendorEmail}` : 'Portal link created and copied');
      reload();
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Could not create the link');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: number) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/business/vendors/${vendorGuid}/portal?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await readErrorBody(res, 'Could not revoke the link'));
      success('Link revoked — it no longer opens');
      reload();
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Could not revoke the link');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-foreground-muted">
        Give this contractor a private, read-only page with the payments you made them, the invoices they covered,
        what is still open, and their 1099 totals. They see nothing else in your books.
      </p>

      {fresh && (
        <div className="space-y-1 rounded-md border border-primary/40 bg-primary-light p-3 text-xs">
          <div className="font-medium text-foreground">
            {fresh.emailed ? 'Emailed. ' : ''}Copy this link now — it will not be shown again.
          </div>
          <input
            readOnly
            aria-label="New portal link"
            value={fresh.url}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-md border border-border bg-input-bg px-2 py-1 font-mono text-[11px] text-foreground"
          />
        </div>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Link expires after"
            value={expiry}
            onChange={(e) => setExpiry(Number(e.target.value))}
            className="rounded-md border border-border bg-input-bg px-2 py-1 text-xs text-foreground"
          >
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.days} value={o.days}>Expires in {o.label}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={() => create(false)}
            className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-surface-hover disabled:opacity-50"
          >
            Create link
          </button>
          {emailConfigured && vendorEmail && (
            <button
              type="button"
              disabled={busy}
              onClick={() => create(true)}
              className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-surface-hover disabled:opacity-50"
            >
              Create &amp; email to {vendorEmail}
            </button>
          )}
        </div>
      )}

      {links && links.length > 0 && (
        <table className="w-full text-xs">
          <thead className="text-foreground-muted">
            <tr>
              <th className="py-1 text-left font-medium">Link</th>
              <th className="py-1 text-left font-medium">Created</th>
              <th className="py-1 text-left font-medium">Expires</th>
              <th className="py-1 text-left font-medium">Last opened</th>
              <th className="py-1 text-right font-medium">Views</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {links.map((l) => (
              <tr key={l.id} className={l.active ? undefined : 'text-foreground-muted'}>
                <td className="py-1 font-mono">{l.prefix}…</td>
                <td className="py-1 font-mono">{day(l.createdAt)}</td>
                <td className="py-1 font-mono">{l.revokedAt ? `revoked ${day(l.revokedAt)}` : day(l.expiresAt)}</td>
                <td className="py-1 font-mono">{day(l.lastViewedAt)}</td>
                <td className="py-1 text-right font-mono">{l.viewCount}</td>
                <td className="py-1 text-right">
                  {canEdit && l.active && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => revoke(l.id)}
                      className="text-foreground-muted hover:text-error disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {links && links.length === 0 && <p className="text-xs text-foreground-muted">No portal links yet.</p>}
    </div>
  );
}
