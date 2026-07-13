'use client';

import { useEffect, useState } from 'react';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';
import { useToast } from '@/contexts/ToastContext';

interface EmailPrefsState {
    enabled: boolean;
    minSeverity: 'info' | 'warning' | 'error';
    types: 'all' | string[];
}

const DEFAULTS: EmailPrefsState = { enabled: false, minSeverity: 'info', types: 'all' };

const TYPE_OPTIONS: Array<{ key: string; label: string }> = [
    { key: 'monthly_digest', label: 'Monthly digest' },
    { key: 'budget_alert', label: 'Budget overspend alerts' },
    { key: 'spending_anomaly', label: 'Spending watch (anomalies & fraud)' },
    { key: 'simplefin_sync', label: 'Bank sync status' },
    { key: 'inventory_reorder', label: 'Inventory low-stock alerts' },
    { key: 'recurring_invoice', label: 'Recurring invoices' },
    { key: 'contribution_limits', label: 'IRS contribution limits' },
    { key: 'background_job', label: 'Background jobs' },
];

export function EmailNotificationsSection() {
    const { success, error } = useToast();
    const [prefs, setPrefs] = useState<EmailPrefsState>(DEFAULTS);
    const [loaded, setLoaded] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        fetch('/api/user/preferences?key=email_notifications')
            .then(r => (r.ok ? r.json() : null))
            .then(data => {
                const raw = data?.preferences?.email_notifications;
                if (raw && typeof raw === 'object') {
                    setPrefs({
                        enabled: raw.enabled === true,
                        minSeverity: raw.minSeverity === 'warning' || raw.minSeverity === 'error' ? raw.minSeverity : 'info',
                        types: Array.isArray(raw.types) ? raw.types : 'all',
                    });
                }
            })
            .catch(() => undefined)
            .finally(() => setLoaded(true));
    }, []);

    const save = async (next: EmailPrefsState) => {
        setPrefs(next);
        setSaving(true);
        try {
            const res = await fetch('/api/user/preferences', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ preferences: { email_notifications: next } }),
            });
            if (!res.ok) throw new Error();
            success('Email notification settings saved');
        } catch {
            error('Failed to save email settings');
        } finally {
            setSaving(false);
        }
    };

    const toggleType = (key: string) => {
        const current = prefs.types === 'all' ? TYPE_OPTIONS.map(t => t.key) : [...prefs.types];
        const next = current.includes(key) ? current.filter(t => t !== key) : [...current, key];
        // Collapse back to 'all' when every type is selected
        const allSelected = TYPE_OPTIONS.every(t => next.includes(t.key));
        void save({ ...prefs, types: allSelected ? 'all' : next });
    };

    const typeChecked = (key: string) => prefs.types === 'all' || prefs.types.includes(key);

    return (
        <CollapsibleConfigSection
            title="Email Notifications"
            summary={prefs.enabled ? 'Enabled' : 'Off'}
            configured
            storageKey="settings.emailNotificationsOpen"
        >
            <div className="space-y-4">
                <p className="text-sm text-foreground-muted">
                    Deliver notifications (digest, overspend, anomalies, low balances, reorders) to your
                    account email. Requires SMTP to be configured on the server (SMTP_HOST etc.).
                </p>

                <label className="flex items-center justify-between gap-3">
                    <span className="text-sm text-foreground">Send notifications by email</span>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={prefs.enabled}
                        disabled={!loaded || saving}
                        onClick={() => void save({ ...prefs, enabled: !prefs.enabled })}
                        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                            prefs.enabled ? 'bg-primary' : 'bg-surface-hover border border-border'
                        }`}
                    >
                        <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                prefs.enabled ? 'translate-x-6' : 'translate-x-1'
                            }`}
                        />
                    </button>
                </label>

                {prefs.enabled && (
                    <>
                        <label className="flex items-center justify-between gap-3">
                            <span className="text-sm text-foreground">Minimum severity</span>
                            <select
                                value={prefs.minSeverity}
                                disabled={saving}
                                onChange={e => void save({ ...prefs, minSeverity: e.target.value as EmailPrefsState['minSeverity'] })}
                                className="bg-background border border-border rounded-lg px-3 py-1.5 text-sm text-foreground"
                            >
                                <option value="info">Everything (info and up)</option>
                                <option value="warning">Warnings and errors</option>
                                <option value="error">Errors only</option>
                            </select>
                        </label>

                        <div>
                            <div className="text-sm text-foreground mb-2">Notification types</div>
                            <div className="grid sm:grid-cols-2 gap-1.5">
                                {TYPE_OPTIONS.map(t => (
                                    <label key={t.key} className="flex items-center gap-2 text-sm text-foreground-secondary">
                                        <input
                                            type="checkbox"
                                            checked={typeChecked(t.key)}
                                            disabled={saving}
                                            onChange={() => toggleType(t.key)}
                                            className="rounded border-border"
                                        />
                                        {t.label}
                                    </label>
                                ))}
                            </div>
                        </div>
                    </>
                )}
            </div>
        </CollapsibleConfigSection>
    );
}
