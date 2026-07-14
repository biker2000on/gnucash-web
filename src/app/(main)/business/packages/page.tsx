'use client';

/**
 * Prepaid Packages — sell session packs as deferred revenue, redeem per visit.
 * Selling books bank → unearned-revenue liability; each redemption recognizes
 * a per-session slice of the liability as income (final redemption absorbs
 * rounding so the liability zeroes out).
 */

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import { formatCurrency } from '@/lib/format';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

interface RedemptionView {
    id: number;
    date: string;
    sessions: number;
    amount: number;
    txnGuid: string | null;
    notes: string | null;
}

interface PackageView {
    id: number;
    name: string;
    clientName: string | null;
    customerGuid: string | null;
    sessionsTotal: number;
    price: number;
    soldDate: string;
    redeemedSessions: number;
    remainingSessions: number;
    redeemedValue: number;
    liabilityBalance: number;
    notes: string | null;
    redemptions: RedemptionView[];
}

interface FlatAccount {
    guid: string;
    fullname: string;
    account_type: string;
}

const inputClass =
    'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50';
const labelClass = 'block text-xs text-foreground-muted uppercase tracking-wider mb-1';

function today(): string {
    return new Date().toISOString().slice(0, 10);
}

export default function PackagesPage() {
    const [packages, setPackages] = useState<PackageView[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [bankAccounts, setBankAccounts] = useState<FlatAccount[]>([]);
    const [sellOpen, setSellOpen] = useState(false);
    const [detailId, setDetailId] = useState<number | null>(null);

    const fetchPackages = useCallback(async () => {
        try {
            const res = await fetch('/api/business/packages');
            if (!res.ok) throw new Error(`Request failed (${res.status})`);
            setPackages(await res.json());
            setError(null);
        } catch {
            setError('Failed to load packages.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchPackages();
    }, [fetchPackages]);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/accounts?flat=true');
                if (!res.ok) return;
                const accounts: FlatAccount[] = await res.json();
                setBankAccounts(accounts.filter((a) => a.account_type === 'BANK' || a.account_type === 'CASH'));
            } catch {
                // Bank picker degrades to empty; the modal shows a hint.
            }
        })();
    }, []);

    const detail = detailId !== null ? packages.find((p) => p.id === detailId) ?? null : null;

    const activeCount = packages.filter((p) => p.remainingSessions > 0).length;
    const outstandingSessions = packages.reduce((s, p) => s + p.remainingSessions, 0);
    const deferredRevenue = packages.reduce((s, p) => s + p.liabilityBalance, 0);

    return (
        <div className="space-y-6">
            <PageHeader
                title="Packages"
                subtitle="Prepaid session packs: sold as deferred revenue, recognized as income per redeemed session."
                actions={
                    <button
                        onClick={() => setSellOpen(true)}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors"
                    >
                        Sell package
                    </button>
                }
            />

            <StatGrid cols={3}>
                <StatCard label="Active packages" value={activeCount} size="compact" />
                <StatCard label="Outstanding sessions" value={outstandingSessions} size="compact" />
                <StatCard
                    label="Deferred revenue"
                    value={formatCurrency(deferredRevenue)}
                    size="compact"
                    tone={deferredRevenue > 0 ? 'primary' : 'default'}
                />
            </StatGrid>

            {loading ? (
                <div className="flex items-center justify-center py-12">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading...</span>
                    </div>
                </div>
            ) : error ? (
                <div className="border border-error/30 bg-surface/30 rounded-xl p-4">
                    <p className="text-sm text-error">{error}</p>
                </div>
            ) : packages.length === 0 ? (
                <div className="bg-background-secondary/30 border border-border rounded-xl p-8 text-center">
                    <p className="text-sm text-foreground-secondary">
                        No packages yet. Sell one to book the cash as deferred revenue and track redemptions here.
                    </p>
                </div>
            ) : (
                <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border">
                                    <th className="px-4 py-3 text-left">Client</th>
                                    <th className="px-4 py-3 text-left">Package</th>
                                    <th className="px-4 py-3 text-left">Redeemed</th>
                                    <th className="px-4 py-3 text-right">Remaining value</th>
                                    <th className="px-4 py-3 text-right">Sold</th>
                                </tr>
                            </thead>
                            <tbody>
                                {packages.map((p) => {
                                    const pct = p.sessionsTotal > 0 ? (p.redeemedSessions / p.sessionsTotal) * 100 : 0;
                                    return (
                                        <tr
                                            key={p.id}
                                            onClick={() => setDetailId(p.id)}
                                            className="border-b border-border/30 last:border-b-0 hover:bg-background-secondary/20 transition-colors cursor-pointer"
                                        >
                                            <td className="px-4 py-2.5 text-foreground">{p.clientName ?? '—'}</td>
                                            <td className="px-4 py-2.5 text-foreground-secondary">{p.name}</td>
                                            <td className="px-4 py-2.5">
                                                <div className="flex items-center gap-2 min-w-[140px]">
                                                    <span className="font-mono text-foreground" style={TNUM}>
                                                        {p.redeemedSessions}/{p.sessionsTotal}
                                                    </span>
                                                    <div className="flex-1 h-1.5 bg-background-tertiary rounded-full overflow-hidden">
                                                        <div
                                                            className={`h-full rounded-full ${p.remainingSessions === 0 ? 'bg-positive' : 'bg-primary'}`}
                                                            style={{ width: `${Math.min(100, pct)}%` }}
                                                        />
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="px-4 py-2.5 text-right font-mono text-foreground" style={TNUM}>
                                                {formatCurrency(p.liabilityBalance)}
                                            </td>
                                            <td className="px-4 py-2.5 text-right font-mono text-foreground-secondary" style={TNUM}>
                                                {p.soldDate}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            <SellPackageModal
                isOpen={sellOpen}
                onClose={() => setSellOpen(false)}
                bankAccounts={bankAccounts}
                onSold={async () => {
                    setSellOpen(false);
                    await fetchPackages();
                }}
            />

            {detail && (
                <PackageDetailModal
                    pkg={detail}
                    onClose={() => setDetailId(null)}
                    onChanged={fetchPackages}
                    onDeleted={async () => {
                        setDetailId(null);
                        await fetchPackages();
                    }}
                />
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Sell modal                                                           */
/* ------------------------------------------------------------------ */

function SellPackageModal({
    isOpen,
    onClose,
    bankAccounts,
    onSold,
}: {
    isOpen: boolean;
    onClose: () => void;
    bankAccounts: FlatAccount[];
    onSold: () => Promise<void>;
}) {
    const [name, setName] = useState('');
    const [clientName, setClientName] = useState('');
    const [sessionsTotal, setSessionsTotal] = useState('10');
    const [price, setPrice] = useState('');
    const [soldDate, setSoldDate] = useState(today);
    const [bankAccountGuid, setBankAccountGuid] = useState('');
    const [notes, setNotes] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const reset = () => {
        setName('');
        setClientName('');
        setSessionsTotal('10');
        setPrice('');
        setSoldDate(today());
        setBankAccountGuid('');
        setNotes('');
        setError(null);
    };

    const handleSubmit = async () => {
        setError(null);
        const sessions = parseInt(sessionsTotal, 10);
        const priceNum = parseFloat(price);
        if (!name.trim()) return setError('Package name is required.');
        if (!Number.isInteger(sessions) || sessions < 1) return setError('Sessions must be a positive whole number.');
        if (!isFinite(priceNum) || priceNum <= 0) return setError('Price must be a positive number.');
        if (!bankAccountGuid) return setError('Pick the bank account that received the payment.');

        setSubmitting(true);
        try {
            const res = await fetch('/api/business/packages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: name.trim(),
                    clientName: clientName.trim() || undefined,
                    sessionsTotal: sessions,
                    price: priceNum,
                    soldDate,
                    bankAccountGuid,
                    notes: notes.trim() || undefined,
                }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error ?? `Request failed (${res.status})`);
            }
            reset();
            await onSold();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to sell the package.');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Sell Package" size="md">
            <div className="p-6 space-y-4">
                <div>
                    <label className={labelClass}>Package name</label>
                    <input value={name} onChange={(e) => setName(e.target.value)} placeholder="10-session pack" className={inputClass} />
                </div>
                <div>
                    <label className={labelClass}>Client</label>
                    <input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Client name (optional)" className={inputClass} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label className={labelClass}>Sessions</label>
                        <input type="number" min={1} step={1} value={sessionsTotal} onChange={(e) => setSessionsTotal(e.target.value)} className={inputClass} />
                    </div>
                    <div>
                        <label className={labelClass}>Price</label>
                        <input type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" className={inputClass} />
                    </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label className={labelClass}>Sold date</label>
                        <input type="date" value={soldDate} onChange={(e) => setSoldDate(e.target.value)} className={inputClass} />
                    </div>
                    <div>
                        <label className={labelClass}>Deposit to</label>
                        <select value={bankAccountGuid} onChange={(e) => setBankAccountGuid(e.target.value)} className={inputClass}>
                            <option value="">Select bank account…</option>
                            {bankAccounts.map((a) => (
                                <option key={a.guid} value={a.guid}>
                                    {a.fullname}
                                </option>
                            ))}
                        </select>
                        {bankAccounts.length === 0 && (
                            <p className="mt-1 text-xs text-foreground-muted">No BANK/CASH accounts found in this book.</p>
                        )}
                    </div>
                </div>
                <div>
                    <label className={labelClass}>Notes</label>
                    <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" className={inputClass} />
                </div>
                <p className="text-xs text-foreground-muted">
                    Books the sale as a deferred-revenue liability (Liabilities:Unearned Revenue:Packages).
                    Income is recognized per redeemed session.
                </p>
                {error && <p className="text-sm text-error">{error}</p>}
                <div className="flex justify-end gap-2 pt-2">
                    <button onClick={onClose} className="px-3 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors">
                        Cancel
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={submitting}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors disabled:opacity-50"
                    >
                        {submitting ? 'Selling…' : 'Sell package'}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

/* ------------------------------------------------------------------ */
/* Detail modal                                                         */
/* ------------------------------------------------------------------ */

function PackageDetailModal({
    pkg,
    onClose,
    onChanged,
    onDeleted,
}: {
    pkg: PackageView;
    onClose: () => void;
    onChanged: () => Promise<void>;
    onDeleted: () => Promise<void>;
}) {
    const [redeemDate, setRedeemDate] = useState(today);
    const [redeemSessions, setRedeemSessions] = useState('1');
    const [redeemNotes, setRedeemNotes] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);

    const redeem = async (body: { date?: string; sessions?: number; notes?: string }) => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/business/packages/${pkg.id}/redemptions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error ?? `Request failed (${res.status})`);
            }
            setRedeemNotes('');
            setRedeemSessions('1');
            await onChanged();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to redeem.');
        } finally {
            setBusy(false);
        }
    };

    const handleDatedRedeem = () => {
        const sessions = parseInt(redeemSessions, 10);
        if (!Number.isInteger(sessions) || sessions < 1) {
            setError('Sessions must be a positive whole number.');
            return;
        }
        redeem({ date: redeemDate, sessions, notes: redeemNotes.trim() || undefined });
    };

    const handleDeleteRedemption = async (id: number) => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/business/packages/redemptions/${id}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error ?? `Request failed (${res.status})`);
            }
            await onChanged();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to delete the redemption.');
        } finally {
            setBusy(false);
        }
    };

    const handleDeletePackage = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/business/packages/${pkg.id}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error ?? `Request failed (${res.status})`);
            }
            await onDeleted();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to delete the package.');
            setBusy(false);
        }
    };

    const exhausted = pkg.remainingSessions === 0;

    return (
        <Modal isOpen onClose={onClose} title={pkg.name} size="lg">
            <div className="p-6 space-y-5">
                <StatGrid cols={4}>
                    <StatCard label="Client" value={<span className="text-sm">{pkg.clientName ?? '—'}</span>} size="compact" />
                    <StatCard label="Redeemed" value={`${pkg.redeemedSessions}/${pkg.sessionsTotal}`} size="compact" />
                    <StatCard label="Recognized" value={formatCurrency(pkg.redeemedValue)} size="compact" />
                    <StatCard
                        label="Liability"
                        value={formatCurrency(pkg.liabilityBalance)}
                        size="compact"
                        tone={exhausted ? 'positive' : 'primary'}
                    />
                </StatGrid>

                <div className="flex flex-wrap items-end gap-2">
                    <button
                        onClick={() => redeem({ date: today(), sessions: 1 })}
                        disabled={busy || exhausted}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors disabled:opacity-50"
                    >
                        Redeem session (today)
                    </button>
                    <div className="flex items-end gap-2 flex-wrap">
                        <div>
                            <label className={labelClass}>Date</label>
                            <input type="date" value={redeemDate} onChange={(e) => setRedeemDate(e.target.value)} className={inputClass} />
                        </div>
                        <div className="w-20">
                            <label className={labelClass}>Sessions</label>
                            <input type="number" min={1} step={1} value={redeemSessions} onChange={(e) => setRedeemSessions(e.target.value)} className={inputClass} />
                        </div>
                        <div className="min-w-[10rem]">
                            <label className={labelClass}>Notes</label>
                            <input value={redeemNotes} onChange={(e) => setRedeemNotes(e.target.value)} placeholder="Optional" className={inputClass} />
                        </div>
                        <button
                            onClick={handleDatedRedeem}
                            disabled={busy || exhausted}
                            className="px-3 py-2 text-sm bg-background-tertiary text-foreground-secondary hover:text-foreground rounded-lg transition-colors disabled:opacity-50"
                        >
                            Redeem dated
                        </button>
                    </div>
                </div>
                {exhausted && (
                    <p className="text-xs text-positive">Fully redeemed — the deferred-revenue liability is zeroed out.</p>
                )}
                {error && <p className="text-sm text-error">{error}</p>}

                <div className="border border-border rounded-xl overflow-hidden">
                    <div className="p-3 border-b border-border">
                        <h3 className="text-xs font-semibold text-foreground uppercase tracking-wider">Redemption history</h3>
                    </div>
                    {pkg.redemptions.length === 0 ? (
                        <div className="p-6 text-center text-foreground-muted text-sm">No redemptions yet.</div>
                    ) : (
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border">
                                    <th className="px-3 py-2 text-left">Date</th>
                                    <th className="px-3 py-2 text-right">Sessions</th>
                                    <th className="px-3 py-2 text-right">Recognized</th>
                                    <th className="px-3 py-2 text-left">Notes</th>
                                    <th className="px-3 py-2" />
                                </tr>
                            </thead>
                            <tbody>
                                {pkg.redemptions.map((r) => (
                                    <tr key={r.id} className="border-b border-border/30 last:border-b-0">
                                        <td className="px-3 py-2 font-mono text-foreground" style={TNUM}>{r.date}</td>
                                        <td className="px-3 py-2 text-right font-mono text-foreground" style={TNUM}>{r.sessions}</td>
                                        <td className="px-3 py-2 text-right font-mono text-foreground" style={TNUM}>{formatCurrency(r.amount)}</td>
                                        <td className="px-3 py-2 text-foreground-secondary">{r.notes ?? ''}</td>
                                        <td className="px-3 py-2 text-right">
                                            <button
                                                onClick={() => handleDeleteRedemption(r.id)}
                                                disabled={busy}
                                                className="text-xs text-foreground-muted hover:text-negative transition-colors disabled:opacity-50"
                                                title="Delete redemption (removes its transaction)"
                                            >
                                                Delete
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>

                <div className="flex items-center justify-between pt-1">
                    {confirmDelete ? (
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-negative">Void this package and remove all its transactions?</span>
                            <button onClick={handleDeletePackage} disabled={busy} className="text-xs text-negative hover:underline disabled:opacity-50">
                                Yes, void
                            </button>
                            <button onClick={() => setConfirmDelete(false)} className="text-xs text-foreground-muted hover:text-foreground">
                                Cancel
                            </button>
                        </div>
                    ) : (
                        <button onClick={() => setConfirmDelete(true)} className="text-xs text-foreground-muted hover:text-negative transition-colors">
                            Void package…
                        </button>
                    )}
                    <span className="text-xs text-foreground-muted font-mono" style={TNUM}>
                        Sold {pkg.soldDate} · {formatCurrency(pkg.price)}
                    </span>
                </div>
            </div>
        </Modal>
    );
}
