'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/contexts/ToastContext';

interface PriceAlert {
    id: number;
    commodityGuid: string;
    mnemonic: string;
    fullname: string | null;
    direction: 'above' | 'below';
    threshold: number;
    enabled: boolean;
    lastTriggeredAt: string | null;
    createdAt: string;
}

interface Commodity {
    guid: string;
    namespace: string;
    mnemonic: string;
    fullname: string | null;
}

function formatThreshold(value: number): string {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function PriceAlertsPage() {
    const { success, error } = useToast();
    const [alerts, setAlerts] = useState<PriceAlert[]>([]);
    const [commodities, setCommodities] = useState<Commodity[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);

    // Add form state
    const [commodityGuid, setCommodityGuid] = useState('');
    const [direction, setDirection] = useState<'above' | 'below'>('above');
    const [threshold, setThreshold] = useState('');

    const load = useCallback(async () => {
        try {
            const [alertsRes, commoditiesRes] = await Promise.all([
                fetch('/api/investments/price-alerts'),
                fetch('/api/commodities'),
            ]);
            if (alertsRes.ok) {
                const data = await alertsRes.json();
                setAlerts(data.alerts ?? []);
            }
            if (commoditiesRes.ok) {
                const data = await commoditiesRes.json();
                if (Array.isArray(data)) setCommodities(data);
            }
        } catch {
            error('Failed to load price alerts');
        } finally {
            setLoading(false);
        }
    }, [error]);

    useEffect(() => {
        void load();
    }, [load]);

    // Alertable commodities: everything except currencies and GnuCash template entries.
    const alertableCommodities = useMemo(
        () => commodities
            .filter(c => c.namespace !== 'CURRENCY' && c.namespace.toLowerCase() !== 'template')
            .sort((a, b) => a.mnemonic.localeCompare(b.mnemonic)),
        [commodities],
    );

    const addAlert = async () => {
        const value = parseFloat(threshold);
        if (!commodityGuid) {
            error('Choose a commodity');
            return;
        }
        if (!Number.isFinite(value) || value <= 0) {
            error('Enter a positive threshold price');
            return;
        }
        setBusy(true);
        try {
            const res = await fetch('/api/investments/price-alerts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ commodityGuid, direction, threshold: value }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to create alert');
            setAlerts(prev => [data.alert, ...prev]);
            setThreshold('');
            success('Price alert created');
        } catch (e) {
            error(e instanceof Error ? e.message : 'Failed to create alert');
        } finally {
            setBusy(false);
        }
    };

    const toggleEnabled = async (alert: PriceAlert) => {
        setBusy(true);
        try {
            const res = await fetch(`/api/investments/price-alerts/${alert.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: !alert.enabled }),
            });
            if (!res.ok) throw new Error();
            setAlerts(prev => prev.map(a => (a.id === alert.id ? { ...a, enabled: !a.enabled } : a)));
        } catch {
            error('Failed to update alert');
        } finally {
            setBusy(false);
        }
    };

    const remove = async (alert: PriceAlert) => {
        if (!window.confirm(`Delete the ${alert.mnemonic} ${alert.direction} ${formatThreshold(alert.threshold)} alert?`)) {
            return;
        }
        setBusy(true);
        try {
            const res = await fetch(`/api/investments/price-alerts/${alert.id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error();
            setAlerts(prev => prev.filter(a => a.id !== alert.id));
            success('Alert deleted');
        } catch {
            error('Failed to delete alert');
        } finally {
            setBusy(false);
        }
    };

    if (loading) {
        return (
            <div className="space-y-6">
                <div className="h-8 bg-background-tertiary rounded animate-pulse w-48" />
                <div className="h-64 bg-background-tertiary rounded-lg animate-pulse" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <PageHeader
                title="Price Alerts"
                subtitle="Get notified when a security crosses a price threshold"
            />

            {/* Add form */}
            <div className="bg-surface border border-border rounded-xl p-4">
                <h2 className="text-sm font-semibold text-foreground mb-3">New alert</h2>
                <div className="flex flex-wrap items-end gap-3">
                    <label className="block space-y-1">
                        <span className="text-xs text-foreground-muted">Commodity</span>
                        <select
                            value={commodityGuid}
                            onChange={e => setCommodityGuid(e.target.value)}
                            disabled={busy}
                            className="block w-56 bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground"
                        >
                            <option value="">Select…</option>
                            {alertableCommodities.map(c => (
                                <option key={c.guid} value={c.guid}>
                                    {c.mnemonic}{c.fullname ? ` — ${c.fullname}` : ''}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="block space-y-1">
                        <span className="text-xs text-foreground-muted">Direction</span>
                        <select
                            value={direction}
                            onChange={e => setDirection(e.target.value as 'above' | 'below')}
                            disabled={busy}
                            className="block bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground"
                        >
                            <option value="above">Rises above</option>
                            <option value="below">Falls below</option>
                        </select>
                    </label>
                    <label className="block space-y-1">
                        <span className="text-xs text-foreground-muted">Threshold price</span>
                        <input
                            type="number"
                            min="0"
                            step="any"
                            value={threshold}
                            onChange={e => setThreshold(e.target.value)}
                            disabled={busy}
                            placeholder="e.g. 250.00"
                            className="block w-36 bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono"
                        />
                    </label>
                    <button
                        type="button"
                        onClick={() => void addAlert()}
                        disabled={busy || !commodityGuid || !threshold}
                        className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                        Add alert
                    </button>
                </div>
                <p className="text-xs text-foreground-muted mt-3">
                    Alerts are checked after each price refresh and re-notify at most once every 24 hours.
                </p>
            </div>

            {/* Alerts table */}
            {alerts.length === 0 ? (
                <div className="bg-surface border border-border rounded-xl p-8 text-center">
                    <p className="text-foreground-secondary text-lg mb-2">No price alerts yet</p>
                    <p className="text-foreground-muted text-sm">
                        Add an alert above to get a notification when a security crosses your threshold.
                    </p>
                </div>
            ) : (
                <div className="bg-surface border border-border rounded-xl overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-foreground-muted border-b border-border">
                                <th className="px-4 py-2.5 font-medium">Commodity</th>
                                <th className="px-4 py-2.5 font-medium">Condition</th>
                                <th className="px-4 py-2.5 font-medium text-right">Threshold</th>
                                <th className="px-4 py-2.5 font-medium">Last triggered</th>
                                <th className="px-4 py-2.5 font-medium">Enabled</th>
                                <th className="px-4 py-2.5 font-medium" />
                            </tr>
                        </thead>
                        <tbody>
                            {alerts.map(a => (
                                <tr key={a.id} className="border-b border-border last:border-0">
                                    <td className="px-4 py-2.5">
                                        <Link
                                            href={`/reports/price_history?commodityGuid=${a.commodityGuid}`}
                                            className="text-primary hover:underline font-medium"
                                        >
                                            {a.mnemonic}
                                        </Link>
                                        {a.fullname && (
                                            <span className="text-foreground-muted ml-2 text-xs">{a.fullname}</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-2.5 text-foreground-secondary">
                                        {a.direction === 'above' ? 'Rises above' : 'Falls below'}
                                    </td>
                                    <td className="px-4 py-2.5 text-right font-mono text-foreground">
                                        {formatThreshold(a.threshold)}
                                    </td>
                                    <td className="px-4 py-2.5 text-foreground-secondary font-mono text-xs">
                                        {a.lastTriggeredAt ? new Date(a.lastTriggeredAt).toLocaleString() : '—'}
                                    </td>
                                    <td className="px-4 py-2.5">
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={a.enabled}
                                            disabled={busy}
                                            onClick={() => void toggleEnabled(a)}
                                            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                                                a.enabled ? 'bg-primary' : 'bg-surface-hover border border-border'
                                            }`}
                                        >
                                            <span
                                                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                                                    a.enabled ? 'translate-x-5' : 'translate-x-1'
                                                }`}
                                            />
                                        </button>
                                    </td>
                                    <td className="px-4 py-2.5 text-right">
                                        <button
                                            type="button"
                                            onClick={() => void remove(a)}
                                            disabled={busy}
                                            className="text-xs text-error hover:underline disabled:opacity-50"
                                        >
                                            Delete
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
