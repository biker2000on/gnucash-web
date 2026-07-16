'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/contexts/ToastContext';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

interface CloseItem {
    key: string;
    title: string;
    description: string;
    links: Array<{ label: string; href: string }>;
    status: 'pending' | 'done';
    completedAt: string | null;
}

interface CloseState {
    month: string;
    monthEnd: string;
    lockDate: string | null;
    monthLocked: boolean;
    role: string;
    items: CloseItem[];
}

function defaultMonth(): string {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return d.toISOString().slice(0, 7);
}

function monthLabel(month: string): string {
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
    });
}

export default function MonthEndClosePage() {
    const toast = useToast();
    const [month, setMonth] = useState(defaultMonth);
    const [state, setState] = useState<CloseState | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [customLockDate, setCustomLockDate] = useState('');

    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/business/close?month=${month}`);
            if (!res.ok) throw new Error(`Request failed (${res.status})`);
            setState(await res.json());
            setError(null);
        } catch {
            setError('Failed to load close state.');
        }
    }, [month]);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        (async () => {
            await load();
            if (!cancelled) setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [load]);

    const put = async (body: Record<string, unknown>): Promise<boolean> => {
        setSaving(true);
        try {
            const res = await fetch('/api/business/close', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
                toast.error(data?.error ?? 'Update failed');
                return false;
            }
            setState(data);
            return true;
        } catch {
            toast.error('Update failed');
            return false;
        } finally {
            setSaving(false);
        }
    };

    const toggleItem = (item: CloseItem) =>
        put({ action: 'checklist', month, itemKey: item.key, done: item.status !== 'done' });

    const lockThrough = async (lockDate: string | null) => {
        const ok = await put({ action: 'lockDate', lockDate, month });
        if (ok) {
            toast.success(
                lockDate
                    ? `Period locked through ${lockDate}`
                    : 'Period lock cleared',
            );
        }
    };

    const isAdmin = state?.role === 'admin';
    const allDone = state ? state.items.every((i) => i.status === 'done') : false;
    const doneCount = state ? state.items.filter((i) => i.status === 'done').length : 0;

    return (
        <div className="space-y-6">
            <PageHeader
                title="Month-End Close"
                subtitle="Work the checklist, then lock the period so finished months stay finished"
                toolbar={
                    <div className="flex items-center gap-3">
                        <label className="text-xs text-foreground-secondary" htmlFor="close-month">
                            Period
                        </label>
                        <input
                            id="close-month"
                            type="month"
                            value={month}
                            onChange={(e) => e.target.value && setMonth(e.target.value)}
                            className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm font-mono text-foreground focus:border-primary/50 focus:outline-none"
                            style={TNUM}
                        />
                        {state && (
                            <span className="text-xs text-foreground-muted font-mono" style={TNUM}>
                                {doneCount}/{state.items.length} done
                            </span>
                        )}
                    </div>
                }
            />

            {loading ? (
                <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-foreground-secondary">
                    Loading…
                </div>
            ) : error || !state ? (
                <div className="rounded-lg border border-error/30 bg-error/10 p-6 text-sm text-error">
                    {error ?? 'Failed to load close state.'}
                </div>
            ) : (
                <>
                    {/* Current lock banner */}
                    <div className="rounded-lg border border-border bg-surface px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                        <span className="text-xs uppercase tracking-wide text-foreground-muted">Lock date</span>
                        <span className="text-sm font-mono text-foreground" style={TNUM}>
                            {state.lockDate ?? 'none'}
                        </span>
                        <span className="text-xs text-foreground-secondary">
                            {state.lockDate
                                ? `Transactions on or before ${state.lockDate} are closed and cannot be changed.`
                                : 'No period is locked yet — every transaction is editable.'}
                        </span>
                        {state.monthLocked && (
                            <span className="inline-block rounded-full border border-primary/30 bg-primary-light px-2 py-0.5 text-[11px] font-medium text-primary">
                                {monthLabel(state.month)} is locked
                            </span>
                        )}
                    </div>

                    {/* Checklist */}
                    <section className="rounded-lg border border-border bg-surface overflow-hidden">
                        <div className="border-b border-border px-4 py-3">
                            <h2 className="text-sm font-semibold text-foreground">
                                Close checklist — {monthLabel(state.month)}
                            </h2>
                        </div>
                        <ul className="divide-y divide-border">
                            {state.items.map((item) => (
                                <li key={item.key} className="flex items-start gap-3 px-4 py-3">
                                    <input
                                        type="checkbox"
                                        id={`chk-${item.key}`}
                                        checked={item.status === 'done'}
                                        disabled={saving}
                                        onChange={() => toggleItem(item)}
                                        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--primary)]"
                                    />
                                    <div className="min-w-0 flex-1">
                                        <label
                                            htmlFor={`chk-${item.key}`}
                                            className={`block text-sm font-medium cursor-pointer ${
                                                item.status === 'done'
                                                    ? 'text-foreground-muted line-through'
                                                    : 'text-foreground'
                                            }`}
                                        >
                                            {item.title}
                                        </label>
                                        <p className="mt-0.5 text-xs text-foreground-secondary">{item.description}</p>
                                        {item.completedAt && (
                                            <p className="mt-0.5 text-[11px] text-foreground-muted font-mono" style={TNUM}>
                                                done {item.completedAt.slice(0, 10)}
                                            </p>
                                        )}
                                    </div>
                                    <div className="flex shrink-0 flex-wrap justify-end gap-2">
                                        {item.links.map((l) => (
                                            <Link
                                                key={l.href + l.label}
                                                href={l.href}
                                                className="rounded-md border border-border px-2 py-1 text-xs text-foreground-secondary hover:border-border-hover hover:text-foreground transition-colors duration-150"
                                            >
                                                {l.label}
                                            </Link>
                                        ))}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </section>

                    {/* Lock the period */}
                    <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
                        <h2 className="text-sm font-semibold text-foreground">Lock the period</h2>
                        <p className="text-xs text-foreground-secondary">
                            Setting the lock date closes the period: every transaction dated on or
                            before it is rejected by edits, deletes, imports, and postings.
                            {!isAdmin && ' Only a book admin can change the lock date.'}
                        </p>
                        {isAdmin && (
                            <div className="flex flex-wrap items-center gap-3">
                                <button
                                    onClick={() => lockThrough(state.monthEnd)}
                                    disabled={saving || state.monthLocked}
                                    title={allDone ? undefined : 'Checklist items are still pending'}
                                    className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50 transition-colors duration-150"
                                >
                                    Lock period through {state.monthEnd}
                                </button>
                                {!allDone && !state.monthLocked && (
                                    <span className="text-xs text-warning">
                                        {state.items.length - doneCount} checklist item
                                        {state.items.length - doneCount === 1 ? '' : 's'} still pending
                                    </span>
                                )}
                                <span className="text-xs text-foreground-muted">or</span>
                                <input
                                    type="date"
                                    value={customLockDate}
                                    onChange={(e) => setCustomLockDate(e.target.value)}
                                    aria-label="Custom lock date"
                                    className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm font-mono text-foreground focus:border-primary/50 focus:outline-none"
                                    style={TNUM}
                                />
                                <button
                                    onClick={() => customLockDate && lockThrough(customLockDate)}
                                    disabled={saving || !customLockDate}
                                    className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground-secondary hover:border-border-hover hover:text-foreground disabled:opacity-50 transition-colors duration-150"
                                >
                                    Set custom lock date
                                </button>
                                {state.lockDate && (
                                    <button
                                        onClick={() => lockThrough(null)}
                                        disabled={saving}
                                        className="rounded-md border border-error/30 px-3 py-1.5 text-sm text-error hover:bg-error/10 disabled:opacity-50 transition-colors duration-150"
                                    >
                                        Clear lock
                                    </button>
                                )}
                            </div>
                        )}
                    </section>
                </>
            )}
        </div>
    );
}
