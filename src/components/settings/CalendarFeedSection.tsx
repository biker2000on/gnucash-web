'use client';

import { useCallback, useEffect, useState } from 'react';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';
import { useToast } from '@/contexts/ToastContext';

interface CalendarFeed {
    id: number;
    bookGuid: string;
    prefix: string;
    eventTypes: string[];
    createdAt: string;
}

const EVENT_TYPE_OPTIONS: Array<{ key: string; label: string }> = [
    { key: 'scheduled', label: 'Scheduled transactions (next 90 days)' },
    { key: 'fixed_income', label: 'Bond/CD maturities & coupon payments' },
    { key: 'rmd', label: 'RMD deadlines' },
    { key: 'compliance', label: 'Tax & compliance deadlines (next 12 months)' },
    { key: 'renewal', label: 'Renewals & contracts' },
    { key: 'home', label: 'Home maintenance' },
    { key: 'invoice', label: 'Invoices & bills' },
    { key: 'goal', label: 'Goal deadlines' },
    { key: 'equity_comp', label: 'Equity compensation vesting' },
    { key: 'report_schedule', label: 'Scheduled report delivery' },
    { key: 'plan', label: 'Living plan events' },
];

function typeLabel(key: string): string {
    return EVENT_TYPE_OPTIONS.find(o => o.key === key)?.label.split(' (')[0] ?? key;
}

export function CalendarFeedSection() {
    const { success, error } = useToast();
    const [feeds, setFeeds] = useState<CalendarFeed[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);

    // Create-flow state
    const [showCreate, setShowCreate] = useState(false);
    const [selectedTypes, setSelectedTypes] = useState<string[]>(
        EVENT_TYPE_OPTIONS.map(o => o.key),
    );
    const [newUrl, setNewUrl] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/settings/calendar-feeds');
            if (!res.ok) throw new Error();
            const data = await res.json();
            setFeeds(data.feeds ?? []);
        } catch {
            // silently keep old list; toast on user-initiated actions only
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const toggleType = (key: string) => {
        setSelectedTypes(prev =>
            prev.includes(key) ? prev.filter(t => t !== key) : [...prev, key],
        );
    };

    const create = async () => {
        if (selectedTypes.length === 0) {
            error('Select at least one event type');
            return;
        }
        setBusy(true);
        try {
            const res = await fetch('/api/settings/calendar-feeds', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ eventTypes: selectedTypes }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to create feed');
            setNewUrl(`${window.location.origin}/api/calendar/${data.secret}`);
            setCopied(false);
            success('Calendar feed created');
            void load();
        } catch (e) {
            error(e instanceof Error ? e.message : 'Failed to create feed');
        } finally {
            setBusy(false);
        }
    };

    const revoke = async (feed: CalendarFeed) => {
        if (!window.confirm('Revoke this calendar feed? Calendar apps subscribed to it will stop updating immediately.')) {
            return;
        }
        setBusy(true);
        try {
            const res = await fetch(`/api/settings/calendar-feeds/${feed.id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error();
            success('Calendar feed revoked');
            setFeeds(prev => prev.filter(f => f.id !== feed.id));
        } catch {
            error('Failed to revoke calendar feed');
        } finally {
            setBusy(false);
        }
    };

    const copyUrl = async () => {
        if (!newUrl) return;
        try {
            await navigator.clipboard.writeText(newUrl);
            setCopied(true);
        } catch {
            error('Copy failed — select and copy manually');
        }
    };

    const closeCreate = () => {
        setShowCreate(false);
        setNewUrl(null);
        setCopied(false);
        setSelectedTypes(EVENT_TYPE_OPTIONS.map(o => o.key));
    };

    return (
        <CollapsibleConfigSection
            title="Calendar Feeds (iCal)"
            summary={feeds.length > 0 ? `${feeds.length} active feed${feeds.length === 1 ? '' : 's'}` : 'None'}
            configured
            storageKey="settings.calendarFeedsOpen"
        >
            <div className="space-y-4">
                <p className="text-sm text-foreground-muted">
                    Subscribe to your finances from any calendar app (Google Calendar, Apple Calendar,
                    Outlook). Feeds include upcoming scheduled transactions, bond/CD maturities and
                    estimated coupons, and RMD deadlines for the current book. The feed URL contains a
                    secret token — treat it like a password and revoke it if it leaks.
                </p>

                {loaded && feeds.length > 0 && (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-foreground-muted border-b border-border">
                                    <th className="py-2 pr-3 font-medium">Feed</th>
                                    <th className="py-2 pr-3 font-medium">Events</th>
                                    <th className="py-2 pr-3 font-medium">Created</th>
                                    <th className="py-2 font-medium" />
                                </tr>
                            </thead>
                            <tbody>
                                {feeds.map(f => (
                                    <tr key={f.id} className="border-b border-border last:border-0">
                                        <td className="py-2 pr-3 font-mono text-xs text-foreground-secondary">{f.prefix}…</td>
                                        <td className="py-2 pr-3 text-foreground-secondary">
                                            {f.eventTypes.map(typeLabel).join(', ')}
                                        </td>
                                        <td className="py-2 pr-3 text-foreground-secondary">
                                            {new Date(f.createdAt).toLocaleDateString()}
                                        </td>
                                        <td className="py-2 text-right">
                                            <button
                                                type="button"
                                                onClick={() => void revoke(f)}
                                                disabled={busy}
                                                className="text-xs text-error hover:underline disabled:opacity-50"
                                            >
                                                Revoke
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {loaded && feeds.length === 0 && (
                    <p className="text-sm text-foreground-secondary">No calendar feeds yet.</p>
                )}

                <button
                    type="button"
                    onClick={() => setShowCreate(true)}
                    disabled={busy}
                    className="px-3 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                    Create feed
                </button>

                {showCreate && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
                        <div className="bg-surface border border-border rounded-xl w-full max-w-md p-5 space-y-4">
                            {!newUrl ? (
                                <>
                                    <h3 className="text-base font-semibold text-foreground">Create calendar feed</h3>
                                    <div>
                                        <div className="text-sm text-foreground mb-2">Include events</div>
                                        <div className="space-y-1.5">
                                            {EVENT_TYPE_OPTIONS.map(o => (
                                                <label key={o.key} className="flex items-center gap-2 text-sm text-foreground-secondary">
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedTypes.includes(o.key)}
                                                        disabled={busy}
                                                        onChange={() => toggleType(o.key)}
                                                        className="rounded border-border"
                                                    />
                                                    {o.label}
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                    <div className="flex justify-end gap-2 pt-1">
                                        <button
                                            type="button"
                                            onClick={closeCreate}
                                            disabled={busy}
                                            className="px-3 py-1.5 text-sm rounded-lg border border-border text-foreground hover:bg-surface-hover"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void create()}
                                            disabled={busy || selectedTypes.length === 0}
                                            className="px-3 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
                                        >
                                            {busy ? 'Creating…' : 'Create'}
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <h3 className="text-base font-semibold text-foreground">Feed created</h3>
                                    <p className="text-sm text-warning">
                                        Copy this URL now — you won&apos;t see it again. Paste it into your
                                        calendar app&apos;s &quot;subscribe by URL&quot; option.
                                    </p>
                                    <div className="flex items-center gap-2">
                                        <code className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-xs font-mono text-foreground break-all select-all">
                                            {newUrl}
                                        </code>
                                        <button
                                            type="button"
                                            onClick={() => void copyUrl()}
                                            className="px-3 py-2 text-sm rounded-lg border border-border text-foreground hover:bg-surface-hover shrink-0"
                                        >
                                            {copied ? 'Copied' : 'Copy'}
                                        </button>
                                    </div>
                                    <div className="flex justify-end pt-1">
                                        <button
                                            type="button"
                                            onClick={closeCreate}
                                            className="px-3 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90"
                                        >
                                            Done
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </CollapsibleConfigSection>
    );
}
