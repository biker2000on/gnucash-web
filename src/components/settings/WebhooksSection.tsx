'use client';

import { useCallback, useEffect, useState } from 'react';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';
import { useToast } from '@/contexts/ToastContext';

interface Webhook {
    id: number;
    bookGuid: string | null;
    url: string;
    secret: string;
    events: 'all' | string[];
    enabled: boolean;
    createdAt: string;
    lastStatus: string | null;
    lastDeliveredAt: string | null;
}

const EVENT_OPTIONS: Array<{ key: string; label: string }> = [
    { key: 'monthly_digest', label: 'Monthly digest' },
    { key: 'budget_alert', label: 'Budget overspend alerts' },
    { key: 'spending_anomaly', label: 'Spending watch (anomalies & fraud)' },
    { key: 'simplefin_sync', label: 'Bank sync status' },
    { key: 'inventory_reorder', label: 'Inventory low-stock alerts' },
    { key: 'recurring_invoice', label: 'Recurring invoices' },
    { key: 'contribution_limits', label: 'IRS contribution limits' },
    { key: 'background_job', label: 'Background jobs' },
];

interface FormState {
    id: number | null; // null = creating
    url: string;
    secret: string;
    events: 'all' | string[];
    enabled: boolean;
    allowInternal: boolean;
}

const EMPTY_FORM: FormState = {
    id: null,
    url: '',
    secret: '',
    events: 'all',
    enabled: true,
    allowInternal: false,
};

function randomSecret(): string {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return 'whsec_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function statusDot(hook: Webhook): { color: string; label: string } {
    if (!hook.enabled) return { color: 'bg-foreground-muted', label: 'Disabled' };
    if (!hook.lastStatus) return { color: 'bg-foreground-muted', label: 'Never delivered' };
    const asNumber = Number(hook.lastStatus);
    if (Number.isFinite(asNumber) && asNumber > 0 && asNumber < 400) {
        return { color: 'bg-success', label: `Last delivery: HTTP ${hook.lastStatus}` };
    }
    return { color: 'bg-error', label: `Last delivery failed: ${hook.lastStatus}` };
}

export function WebhooksSection() {
    const { success, error } = useToast();
    const [webhooks, setWebhooks] = useState<Webhook[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [testingId, setTestingId] = useState<number | null>(null);
    const [form, setForm] = useState<FormState | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/settings/webhooks');
            if (!res.ok) throw new Error();
            const data = await res.json();
            setWebhooks(data.webhooks ?? []);
        } catch {
            // keep old list
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const save = async () => {
        if (!form) return;
        if (!form.url.trim()) {
            error('Webhook URL is required');
            return;
        }
        setBusy(true);
        try {
            const payload = {
                url: form.url.trim(),
                secret: form.secret || undefined,
                events: form.events,
                enabled: form.enabled,
                allowInternal: form.allowInternal,
            };
            const res = form.id === null
                ? await fetch('/api/settings/webhooks', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                })
                : await fetch(`/api/settings/webhooks/${form.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to save webhook');
            success(form.id === null ? 'Webhook created' : 'Webhook updated');
            setForm(null);
            void load();
        } catch (e) {
            error(e instanceof Error ? e.message : 'Failed to save webhook');
        } finally {
            setBusy(false);
        }
    };

    const remove = async (hook: Webhook) => {
        if (!window.confirm('Delete this webhook?')) return;
        setBusy(true);
        try {
            const res = await fetch(`/api/settings/webhooks/${hook.id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error();
            success('Webhook deleted');
            setWebhooks(prev => prev.filter(w => w.id !== hook.id));
        } catch {
            error('Failed to delete webhook');
        } finally {
            setBusy(false);
        }
    };

    const test = async (hook: Webhook) => {
        setTestingId(hook.id);
        try {
            const res = await fetch(`/api/settings/webhooks/${hook.id}/test`, { method: 'POST' });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Test failed');
            if (data.ok) {
                success(`Test delivered (HTTP ${data.status})`);
            } else {
                error(`Test delivery failed: ${data.status}`);
            }
            void load();
        } catch (e) {
            error(e instanceof Error ? e.message : 'Test failed');
        } finally {
            setTestingId(null);
        }
    };

    const toggleEvent = (key: string) => {
        if (!form) return;
        const current = form.events === 'all' ? EVENT_OPTIONS.map(o => o.key) : [...form.events];
        const next = current.includes(key) ? current.filter(k => k !== key) : [...current, key];
        const allSelected = EVENT_OPTIONS.every(o => next.includes(o.key));
        setForm({ ...form, events: allSelected ? 'all' : next });
    };

    const eventChecked = (key: string) =>
        form !== null && (form.events === 'all' || form.events.includes(key));

    return (
        <CollapsibleConfigSection
            title="Webhooks"
            summary={webhooks.length > 0 ? `${webhooks.length} endpoint${webhooks.length === 1 ? '' : 's'}` : 'None'}
            configured
            storageKey="settings.webhooksOpen"
        >
            <div className="space-y-4">
                <p className="text-sm text-foreground-muted">
                    Send notifications (budget alerts, anomalies, sync status, digests) to external
                    services as signed JSON POSTs. Each delivery includes an
                    <code className="mx-1 px-1 py-0.5 bg-surface-hover rounded text-xs">X-GnucashWeb-Signature</code>
                    HMAC header — see <code className="px-1 py-0.5 bg-surface-hover rounded text-xs">docs/api-tokens.md</code> for
                    verification snippets.
                </p>

                {loaded && webhooks.length > 0 && (
                    <ul className="space-y-2">
                        {webhooks.map(hook => {
                            const dot = statusDot(hook);
                            return (
                                <li key={hook.id} className="flex items-center gap-3 border border-border rounded-lg px-3 py-2">
                                    <span
                                        className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${dot.color}`}
                                        title={dot.label}
                                    />
                                    <div className="min-w-0 flex-1">
                                        <div className="text-sm text-foreground font-mono truncate">{hook.url}</div>
                                        <div className="text-xs text-foreground-muted">
                                            {hook.events === 'all' ? 'All events' : `${hook.events.length} event type${hook.events.length === 1 ? '' : 's'}`}
                                            {!hook.enabled && ' · disabled'}
                                            {hook.lastDeliveredAt && ` · last delivery ${new Date(hook.lastDeliveredAt).toLocaleString()}`}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        <button
                                            type="button"
                                            onClick={() => void test(hook)}
                                            disabled={busy || testingId !== null}
                                            className="text-xs text-foreground-secondary hover:underline disabled:opacity-50"
                                        >
                                            {testingId === hook.id ? 'Testing…' : 'Test'}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setForm({
                                                id: hook.id,
                                                url: hook.url,
                                                secret: '',
                                                events: hook.events,
                                                enabled: hook.enabled,
                                                allowInternal: false,
                                            })}
                                            disabled={busy}
                                            className="text-xs text-foreground-secondary hover:underline disabled:opacity-50"
                                        >
                                            Edit
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void remove(hook)}
                                            disabled={busy}
                                            className="text-xs text-error hover:underline disabled:opacity-50"
                                        >
                                            Delete
                                        </button>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}

                {loaded && webhooks.length === 0 && (
                    <p className="text-sm text-foreground-secondary">No webhooks yet.</p>
                )}

                <button
                    type="button"
                    onClick={() => setForm({ ...EMPTY_FORM, secret: randomSecret() })}
                    disabled={busy}
                    className="px-3 py-1.5 text-sm rounded-lg bg-primary text-white hover:opacity-90 disabled:opacity-50"
                >
                    Add webhook
                </button>

                {form && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
                        <div className="bg-surface border border-border rounded-xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto">
                            <h3 className="text-base font-semibold text-foreground">
                                {form.id === null ? 'Add webhook' : 'Edit webhook'}
                            </h3>

                            <label className="block space-y-1">
                                <span className="text-sm text-foreground">Endpoint URL</span>
                                <input
                                    type="url"
                                    value={form.url}
                                    onChange={e => setForm({ ...form, url: e.target.value })}
                                    placeholder="https://example.com/hooks/gnucash"
                                    className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono"
                                />
                            </label>

                            <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                                <input
                                    type="checkbox"
                                    checked={form.allowInternal}
                                    onChange={e => setForm({ ...form, allowInternal: e.target.checked })}
                                    className="rounded border-border"
                                />
                                Allow private/internal hosts (LAN, localhost)
                            </label>

                            <div className="space-y-1">
                                <span className="text-sm text-foreground">Signing secret</span>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="text"
                                        value={form.secret}
                                        onChange={e => setForm({ ...form, secret: e.target.value })}
                                        placeholder={form.id !== null ? '(unchanged)' : ''}
                                        className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-xs text-foreground font-mono"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setForm({ ...form, secret: randomSecret() })}
                                        className="px-3 py-2 text-sm rounded-lg border border-border text-foreground hover:bg-surface-hover shrink-0"
                                    >
                                        Generate
                                    </button>
                                </div>
                                <p className="text-xs text-foreground-muted">
                                    Used to compute the HMAC signature. Store it on the receiving end.
                                </p>
                            </div>

                            <div>
                                <div className="text-sm text-foreground mb-2">Events</div>
                                <div className="grid sm:grid-cols-2 gap-1.5">
                                    {EVENT_OPTIONS.map(o => (
                                        <label key={o.key} className="flex items-center gap-2 text-sm text-foreground-secondary">
                                            <input
                                                type="checkbox"
                                                checked={eventChecked(o.key)}
                                                onChange={() => toggleEvent(o.key)}
                                                className="rounded border-border"
                                            />
                                            {o.label}
                                        </label>
                                    ))}
                                </div>
                            </div>

                            <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                                <input
                                    type="checkbox"
                                    checked={form.enabled}
                                    onChange={e => setForm({ ...form, enabled: e.target.checked })}
                                    className="rounded border-border"
                                />
                                Enabled
                            </label>

                            <div className="flex justify-end gap-2 pt-1">
                                <button
                                    type="button"
                                    onClick={() => setForm(null)}
                                    disabled={busy}
                                    className="px-3 py-1.5 text-sm rounded-lg border border-border text-foreground hover:bg-surface-hover"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void save()}
                                    disabled={busy || !form.url.trim()}
                                    className="px-3 py-1.5 text-sm rounded-lg bg-primary text-white hover:opacity-90 disabled:opacity-50"
                                >
                                    {busy ? 'Saving…' : 'Save'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </CollapsibleConfigSection>
    );
}
