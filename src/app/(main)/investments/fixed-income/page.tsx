'use client';

import { useCallback, useEffect, useState } from 'react';
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
} from 'recharts';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import { Modal } from '@/components/ui/Modal';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { formatCurrency } from '@/lib/format';
import type {
    FixedIncomeSummary,
    ComputedFixedIncomePosition,
    FixedIncomeKind,
    LadderBucket,
} from '@/lib/fixed-income';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

const KIND_LABELS: Record<FixedIncomeKind, string> = {
    bond: 'Bond',
    cd: 'CD',
    treasury: 'Treasury',
    ibond: 'I-Bond',
};

const KIND_BADGE_CLASSES: Record<FixedIncomeKind, string> = {
    bond: 'bg-secondary-light text-secondary',
    cd: 'bg-primary-light text-primary',
    treasury: 'bg-positive/10 text-positive',
    ibond: 'bg-warning/10 text-warning',
};

function KindBadge({ kind, callable }: { kind: FixedIncomeKind; callable?: boolean }) {
    return (
        <span className="inline-flex items-center gap-1">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${KIND_BADGE_CLASSES[kind]}`}>
                {KIND_LABELS[kind]}
            </span>
            {callable && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-background-tertiary text-foreground-muted" title="Issuer may redeem before maturity">
                    Callable
                </span>
            )}
        </span>
    );
}

function formatDate(iso: string): string {
    const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
    return new Date(y, m - 1, d).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
    });
}

function formatPct(value: number | null): string {
    return value != null ? `${value.toFixed(2)}%` : '—';
}

/* ------------------------------------------------------------------ */
/* Ladder chart                                                        */
/* ------------------------------------------------------------------ */

function formatAxisCurrency(value: number): string {
    if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
    if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(0)}k`;
    return `$${value.toFixed(0)}`;
}

interface LadderTooltipProps {
    active?: boolean;
    payload?: Array<{ payload: LadderBucket }>;
    label?: number | string;
}

function LadderTooltip({ active, payload, label }: LadderTooltipProps) {
    if (!active || !payload || !payload.length) return null;
    const bucket = payload[0].payload;
    return (
        <div className="bg-background border border-border rounded-lg p-3 shadow-xl">
            <p className="text-xs text-foreground-muted mb-1">Maturing in {label}</p>
            <p className="text-sm font-semibold font-mono text-foreground" style={TNUM}>
                {formatCurrency(bucket.faceValue)} face
            </p>
            <p className="text-xs text-foreground-secondary font-mono" style={TNUM}>
                {formatCurrency(bucket.currentValue)} current · {bucket.count} position{bucket.count === 1 ? '' : 's'}
            </p>
        </div>
    );
}

function LadderChart({ ladder }: { ladder: LadderBucket[] }) {
    if (ladder.length === 0) {
        return (
            <div className="h-[260px] flex items-center justify-center">
                <p className="text-foreground-muted text-sm">No active positions to chart.</p>
            </div>
        );
    }
    return (
        <ResponsiveContainer width="100%" height={260}>
            <BarChart data={ladder} margin={{ top: 5, right: 16, left: 8, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                    dataKey="year"
                    stroke="var(--foreground-secondary)"
                    tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                    axisLine={{ stroke: 'var(--border)' }}
                    tickLine={{ stroke: 'var(--border)' }}
                />
                <YAxis
                    tickFormatter={formatAxisCurrency}
                    stroke="var(--foreground-secondary)"
                    tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                    axisLine={{ stroke: 'var(--border)' }}
                    tickLine={{ stroke: 'var(--border)' }}
                    width={64}
                />
                <Tooltip content={<LadderTooltip />} cursor={{ fill: 'var(--surface-hover)', opacity: 0.4 }} />
                <Bar dataKey="faceValue" fill="var(--primary)" radius={[2, 2, 0, 0]} name="Face value maturing" />
            </BarChart>
        </ResponsiveContainer>
    );
}

/* ------------------------------------------------------------------ */
/* Add / edit modal                                                    */
/* ------------------------------------------------------------------ */

interface MetadataForm {
    accountGuid: string;
    accountName: string;
    kind: FixedIncomeKind;
    faceValue: string;
    couponRate: string;
    purchaseDate: string;
    maturityDate: string;
    callable: boolean;
}

const EMPTY_FORM: MetadataForm = {
    accountGuid: '',
    accountName: '',
    kind: 'cd',
    faceValue: '',
    couponRate: '',
    purchaseDate: '',
    maturityDate: '',
    callable: false,
};

function PositionModal({
    isOpen,
    initial,
    onClose,
    onSaved,
}: {
    isOpen: boolean;
    initial: MetadataForm;
    onClose: () => void;
    onSaved: () => void;
}) {
    const [form, setForm] = useState<MetadataForm>(initial);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const isEdit = !!initial.accountGuid;

    useEffect(() => {
        if (isOpen) {
            setForm(initial);
            setError(null);
        }
    }, [isOpen, initial]);

    const inputClass =
        'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground ' +
        'placeholder-foreground-muted focus:outline-none focus:border-primary/60';
    const labelClass = 'block text-xs font-medium text-foreground-secondary mb-1';

    const save = async () => {
        setError(null);
        if (!form.accountGuid) { setError('Select the account holding this instrument.'); return; }
        if (!form.faceValue || !(parseFloat(form.faceValue) > 0)) { setError('Face value must be a positive number.'); return; }
        if (!form.maturityDate) { setError('Maturity date is required.'); return; }

        setSaving(true);
        try {
            const res = await fetch(`/api/investments/fixed-income/${form.accountGuid}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind: form.kind,
                    faceValue: parseFloat(form.faceValue),
                    couponRate: form.couponRate ? parseFloat(form.couponRate) : 0,
                    purchaseDate: form.purchaseDate || null,
                    maturityDate: form.maturityDate,
                    callable: form.callable,
                }),
            });
            if (!res.ok) throw new Error((await res.json()).error || 'Failed to save');
            onSaved();
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save');
        } finally {
            setSaving(false);
        }
    };

    const remove = async () => {
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(`/api/investments/fixed-income/${form.accountGuid}`, { method: 'DELETE' });
            if (!res.ok) throw new Error((await res.json()).error || 'Failed to remove');
            onSaved();
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to remove');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={isEdit ? 'Edit fixed-income position' : 'Add fixed-income position'} size="md">
            <div className="p-6 space-y-4">
                <div>
                    <label className={labelClass}>Account holding the instrument</label>
                    {isEdit ? (
                        <div className="px-3 py-2 bg-background-tertiary border border-border rounded-lg text-sm text-foreground">
                            {form.accountName}
                        </div>
                    ) : (
                        <AccountSelector
                            value={form.accountGuid}
                            onChange={(guid, name) => setForm(f => ({ ...f, accountGuid: guid, accountName: name }))}
                            accountTypes={['BANK', 'ASSET', 'STOCK']}
                            placeholder="Select a BANK / ASSET / STOCK account…"
                        />
                    )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className={labelClass}>Kind</label>
                        <select
                            value={form.kind}
                            onChange={e => setForm(f => ({ ...f, kind: e.target.value as FixedIncomeKind }))}
                            className={inputClass}
                        >
                            <option value="cd">CD</option>
                            <option value="bond">Bond</option>
                            <option value="treasury">Treasury</option>
                            <option value="ibond">I-Bond</option>
                        </select>
                    </div>
                    <div>
                        <label className={labelClass}>Face value ($)</label>
                        <input
                            type="number" min="0" step="100"
                            value={form.faceValue}
                            onChange={e => setForm(f => ({ ...f, faceValue: e.target.value }))}
                            className={`${inputClass} font-mono`}
                            style={TNUM}
                            placeholder="10000"
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Coupon rate (% / yr)</label>
                        <input
                            type="number" min="0" max="100" step="0.05"
                            value={form.couponRate}
                            onChange={e => setForm(f => ({ ...f, couponRate: e.target.value }))}
                            className={`${inputClass} font-mono`}
                            style={TNUM}
                            placeholder="4.25 (0 for zero-coupon)"
                        />
                    </div>
                    <div className="flex items-end pb-2">
                        <label className="flex items-center gap-2 text-sm text-foreground-secondary cursor-pointer">
                            <input
                                type="checkbox"
                                checked={form.callable}
                                onChange={e => setForm(f => ({ ...f, callable: e.target.checked }))}
                                className="accent-[var(--primary)]"
                            />
                            Callable
                        </label>
                    </div>
                    <div>
                        <label className={labelClass}>Purchase date</label>
                        <input
                            type="date"
                            value={form.purchaseDate}
                            onChange={e => setForm(f => ({ ...f, purchaseDate: e.target.value }))}
                            className={`${inputClass} font-mono`}
                            style={TNUM}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Maturity date</label>
                        <input
                            type="date"
                            value={form.maturityDate}
                            onChange={e => setForm(f => ({ ...f, maturityDate: e.target.value }))}
                            className={`${inputClass} font-mono`}
                            style={TNUM}
                        />
                    </div>
                </div>

                {error && <p className="text-sm text-negative">{error}</p>}

                <div className="flex items-center justify-between pt-2">
                    <div>
                        {isEdit && (
                            <button
                                onClick={remove}
                                disabled={saving}
                                className="px-3 py-1.5 text-xs font-medium rounded border border-error/40 text-negative hover:bg-error/10 transition-colors disabled:opacity-40"
                            >
                                Remove tracking
                            </button>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={onClose}
                            disabled={saving}
                            className="px-3 py-1.5 text-xs font-medium rounded border border-border text-foreground-secondary hover:bg-surface-hover transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={save}
                            disabled={saving}
                            className="px-4 py-1.5 text-xs font-medium rounded bg-primary text-primary-foreground disabled:opacity-40 transition-colors"
                        >
                            {saving ? 'Saving…' : 'Save position'}
                        </button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function FixedIncomePage() {
    const [data, setData] = useState<FixedIncomeSummary | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [modalInitial, setModalInitial] = useState<MetadataForm>(EMPTY_FORM);

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/investments/fixed-income');
            if (!res.ok) throw new Error((await res.json()).error || 'Failed to load fixed income data');
            setData(await res.json());
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load fixed income data');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const openAdd = () => {
        setModalInitial({ ...EMPTY_FORM });
        setModalOpen(true);
    };

    const openEdit = (p: ComputedFixedIncomePosition) => {
        setModalInitial({
            accountGuid: p.accountGuid,
            accountName: p.accountPath || p.accountName,
            kind: p.kind,
            faceValue: String(p.faceValue),
            couponRate: String(p.couponRate),
            purchaseDate: p.purchaseDate ?? '',
            maturityDate: p.maturityDate,
            callable: p.callable,
        });
        setModalOpen(true);
    };

    if (loading) {
        return (
            <div className="space-y-6">
                <div className="h-8 bg-background-tertiary rounded animate-pulse w-56" />
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                    {[1, 2, 3, 4].map(i => <div key={i} className="h-24 bg-background-tertiary rounded-lg animate-pulse" />)}
                </div>
                <div className="h-72 bg-background-tertiary rounded-lg animate-pulse" />
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="space-y-6">
                <PageHeader title="Fixed Income Ladder" subtitle="Bonds, CDs, treasuries, and I-Bonds by maturity" />
                <div className="bg-surface border border-border rounded-lg p-8 text-center">
                    <p className="text-negative">{error ?? 'Failed to load fixed income data'}</p>
                </div>
            </div>
        );
    }

    const addButton = (
        <button
            onClick={openAdd}
            className="px-3 py-1.5 text-xs font-medium rounded bg-primary text-primary-foreground transition-colors"
        >
            Add position
        </button>
    );

    if (data.positions.length === 0) {
        return (
            <div className="space-y-6">
                <PageHeader
                    title="Fixed Income Ladder"
                    subtitle="Bonds, CDs, treasuries, and I-Bonds by maturity"
                    actions={addButton}
                />
                <div className="bg-surface border border-border rounded-lg p-8 text-center">
                    <p className="text-foreground-secondary text-lg mb-2">No fixed-income positions yet</p>
                    <p className="text-foreground-muted max-w-lg mx-auto">
                        Mark the accounts that hold your CDs, bonds, treasuries, or I-Bonds with face
                        value, coupon, and maturity — the ladder, yields, and maturity calendar are
                        computed from the account balances.
                    </p>
                    <div className="mt-4 flex justify-center">{addButton}</div>
                </div>
                <PositionModal isOpen={modalOpen} initial={modalInitial} onClose={() => setModalOpen(false)} onSaved={load} />
            </div>
        );
    }

    const { stats } = data;

    return (
        <div className="space-y-6">
            <PageHeader
                title="Fixed Income Ladder"
                subtitle="Bonds, CDs, treasuries, and I-Bonds by maturity"
                actions={addButton}
            />

            {/* Stat cards */}
            <StatGrid cols={4}>
                <StatCard
                    label="Total Face Value"
                    value={formatCurrency(stats.totalFace)}
                    sub={`${stats.activeCount} active position${stats.activeCount === 1 ? '' : 's'}${stats.maturedCount ? ` · ${stats.maturedCount} matured` : ''}`}
                />
                <StatCard
                    label="Current Value"
                    value={formatCurrency(stats.totalCurrentValue)}
                    sub="from account balances"
                />
                <StatCard
                    label="Weighted Avg Maturity"
                    value={stats.weightedAvgMaturityYears != null ? `${stats.weightedAvgMaturityYears.toFixed(1)} yrs` : '—'}
                    sub="value-weighted"
                />
                <StatCard
                    label="Weighted Avg YTM"
                    value={formatPct(stats.weightedAvgYtm)}
                    sub={`~${formatCurrency(stats.couponIncomeNext12mo)} coupons next 12mo`}
                    tone="positive"
                />
            </StatGrid>

            {/* Ladder chart */}
            <div className="bg-surface border border-border rounded-lg p-4 sm:p-6">
                <h2 className="text-sm font-semibold text-foreground mb-1">Maturity Ladder</h2>
                <p className="text-xs text-foreground-muted mb-4">Face value maturing per calendar year.</p>
                <LadderChart ladder={data.ladder} />
            </div>

            {/* Positions table */}
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
                <div className="px-4 py-2.5 border-b border-border bg-background-secondary">
                    <h2 className="text-sm font-semibold text-foreground">Positions</h2>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[820px]">
                        <thead>
                            <tr className="text-left text-[11px] uppercase tracking-wider text-foreground-muted border-b border-border">
                                <th className="px-4 py-2 font-medium">Account</th>
                                <th className="px-4 py-2 font-medium">Kind</th>
                                <th className="px-4 py-2 font-medium text-right">Face</th>
                                <th className="px-4 py-2 font-medium text-right">Coupon</th>
                                <th className="px-4 py-2 font-medium text-right">Maturity</th>
                                <th className="px-4 py-2 font-medium text-right">Yrs</th>
                                <th className="px-4 py-2 font-medium text-right">YTM</th>
                                <th className="px-4 py-2 font-medium text-right">Current Value</th>
                                <th className="px-2 py-2" />
                            </tr>
                        </thead>
                        <tbody>
                            {data.positions.map(p => (
                                <tr key={p.accountGuid} className={`border-b border-border last:border-b-0 ${p.matured ? 'opacity-50' : ''}`}>
                                    <td className="px-4 py-2">
                                        <div className="text-foreground font-medium whitespace-nowrap">{p.accountName}</div>
                                        <div className="text-xs text-foreground-muted whitespace-nowrap">{p.accountPath}</div>
                                    </td>
                                    <td className="px-4 py-2 whitespace-nowrap">
                                        <KindBadge kind={p.kind} callable={p.callable} />
                                        {p.matured && (
                                            <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-background-tertiary text-foreground-muted">
                                                Matured
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-4 py-2 text-right font-mono text-foreground whitespace-nowrap" style={TNUM}>
                                        {formatCurrency(p.faceValue)}
                                    </td>
                                    <td className="px-4 py-2 text-right font-mono text-foreground-secondary whitespace-nowrap" style={TNUM}>
                                        {p.couponRate.toFixed(2)}%
                                    </td>
                                    <td className="px-4 py-2 text-right font-mono text-foreground-secondary whitespace-nowrap" style={TNUM}>
                                        {formatDate(p.maturityDate)}
                                    </td>
                                    <td className="px-4 py-2 text-right font-mono text-foreground-secondary whitespace-nowrap" style={TNUM}>
                                        {p.matured ? '—' : p.yearsToMaturity.toFixed(1)}
                                    </td>
                                    <td className={`px-4 py-2 text-right font-mono whitespace-nowrap ${p.ytm != null && p.ytm >= 0 ? 'text-positive' : 'text-foreground-secondary'}`} style={TNUM}>
                                        {formatPct(p.ytm)}
                                    </td>
                                    <td className="px-4 py-2 text-right font-mono text-foreground whitespace-nowrap" style={TNUM}>
                                        {formatCurrency(p.currentValue)}
                                    </td>
                                    <td className="px-2 py-2 text-right">
                                        <button
                                            onClick={() => openEdit(p)}
                                            className="px-2 py-1 text-xs font-medium rounded text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors"
                                        >
                                            Edit
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Maturity calendar + coupons */}
            <div className="grid gap-6 lg:grid-cols-2">
                <div className="bg-surface border border-border rounded-lg overflow-hidden">
                    <div className="px-4 py-2.5 border-b border-border bg-background-secondary">
                        <h2 className="text-sm font-semibold text-foreground">Maturing in the Next 12 Months</h2>
                    </div>
                    {data.upcomingMaturities.length === 0 ? (
                        <p className="p-6 text-sm text-foreground-muted">Nothing matures in the next 12 months.</p>
                    ) : (
                        <ul className="divide-y divide-border">
                            {data.upcomingMaturities.map(m => (
                                <li key={m.accountGuid} className="px-4 py-3 flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-medium text-foreground truncate">{m.accountName}</span>
                                            <KindBadge kind={m.kind} />
                                        </div>
                                        <div className="text-xs text-foreground-muted mt-0.5">
                                            <span className="font-mono" style={TNUM}>{formatDate(m.maturityDate)}</span>
                                            {' · '}
                                            <span className="font-mono" style={TNUM}>{m.daysUntil}</span> days —{' '}
                                            <span className="text-warning">plan reinvestment</span>
                                        </div>
                                    </div>
                                    <div className="text-right shrink-0">
                                        <div className="text-sm font-mono font-semibold text-foreground" style={TNUM}>
                                            {formatCurrency(m.faceValue)}
                                        </div>
                                        <div className="text-xs font-mono text-foreground-muted" style={TNUM}>
                                            now {formatCurrency(m.currentValue)}
                                        </div>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <div className="bg-surface border border-border rounded-lg overflow-hidden">
                    <div className="px-4 py-2.5 border-b border-border bg-background-secondary">
                        <h2 className="text-sm font-semibold text-foreground">Estimated Coupon Payments (next 12 months)</h2>
                    </div>
                    {data.couponPayments.length === 0 ? (
                        <p className="p-6 text-sm text-foreground-muted">
                            No coupon payments expected (zero-coupon positions and I-Bonds compound instead of paying out).
                        </p>
                    ) : (
                        <ul className="divide-y divide-border max-h-[420px] overflow-y-auto">
                            {data.couponPayments.map((c, i) => (
                                <li key={`${c.accountGuid}-${c.date}-${i}`} className="px-4 py-2.5 flex items-center justify-between gap-3">
                                    <div className="min-w-0 flex items-center gap-2">
                                        <span className="text-xs font-mono text-foreground-secondary" style={TNUM}>{formatDate(c.date)}</span>
                                        <span className="text-sm text-foreground truncate">{c.accountName}</span>
                                    </div>
                                    <span className="text-sm font-mono font-medium text-positive shrink-0" style={TNUM}>
                                        {formatCurrency(c.amount)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>

            <p className="text-xs text-foreground-muted">
                YTM is solved from the standard bond price equation (semiannual compounding) using the
                account&apos;s current balance as the price. Coupon estimates assume semiannual payments
                anchored to the maturity date.
            </p>

            <PositionModal isOpen={modalOpen} initial={modalInitial} onClose={() => setModalOpen(false)} onSaved={load} />
        </div>
    );
}
