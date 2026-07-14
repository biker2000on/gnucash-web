'use client';

/**
 * Restricted Funds report — per-fund income/expense/net for a period plus
 * net assets to date, with fund CRUD and per-fund account assignment.
 */

import { useState, useEffect, useCallback } from 'react';
import type { DateRange } from '@/lib/datePresets';
import { PageHeader } from '@/components/ui/PageHeader';
import { FilterBar } from '@/components/ui/FilterBar';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { Modal } from '@/components/ui/Modal';
import { formatCurrency } from '@/lib/format';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

type FundRestriction = 'unrestricted' | 'temporarily_restricted' | 'permanently_restricted';

interface FundView {
    id: number;
    name: string;
    restriction: FundRestriction;
    description: string | null;
    active: boolean;
    sortOrder: number;
    accountGuids: string[];
}

interface FundReportRow {
    fundId: number | null;
    name: string;
    restriction: FundRestriction | null;
    active: boolean;
    income: number;
    expense: number;
    net: number;
    netAssets: number;
    accountCount: number;
}

interface FundReport {
    startDate: string | null;
    endDate: string | null;
    rows: FundReportRow[];
    totals: { income: number; expense: number; net: number; netAssets: number };
}

interface FlatAccount {
    guid: string;
    fullname: string;
    account_type: string;
}

const ASSIGNABLE_TYPES = new Set(['INCOME', 'EXPENSE', 'ASSET', 'BANK', 'EQUITY']);

const RESTRICTION_LABELS: Record<FundRestriction, string> = {
    unrestricted: 'Unrestricted',
    temporarily_restricted: 'Temp. restricted',
    permanently_restricted: 'Perm. restricted',
};

const inputClass =
    'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50';
const labelClass = 'block text-xs text-foreground-muted uppercase tracking-wider mb-1';

function RestrictionBadge({ restriction }: { restriction: FundRestriction | null }) {
    if (!restriction) {
        return <span className="text-xs text-foreground-muted">—</span>;
    }
    const cls =
        restriction === 'unrestricted'
            ? 'bg-primary-light text-primary'
            : restriction === 'temporarily_restricted'
              ? 'bg-warning/10 text-warning'
              : 'bg-secondary-light text-secondary';
    return (
        <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${cls}`}>
            {RESTRICTION_LABELS[restriction]}
        </span>
    );
}

export default function FundsReportPage() {
    const year = new Date().getFullYear();
    const [startDate, setStartDate] = useState<string | null>(`${year}-01-01`);
    const [endDate, setEndDate] = useState<string | null>(new Date().toISOString().slice(0, 10));
    const [report, setReport] = useState<FundReport | null>(null);
    const [funds, setFunds] = useState<FundView[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [manageOpen, setManageOpen] = useState(false);
    const [assignFund, setAssignFund] = useState<FundView | null>(null);

    const refresh = useCallback(async () => {
        try {
            const params = new URLSearchParams({ view: 'report' });
            if (startDate) params.set('startDate', startDate);
            if (endDate) params.set('endDate', endDate);
            const [reportRes, fundsRes] = await Promise.all([
                fetch(`/api/business/funds?${params}`),
                fetch('/api/business/funds'),
            ]);
            if (!reportRes.ok || !fundsRes.ok) throw new Error('Request failed');
            setReport(await reportRes.json());
            setFunds(await fundsRes.json());
            setError(null);
        } catch {
            setError('Failed to load the funds report.');
        } finally {
            setLoading(false);
        }
    }, [startDate, endDate]);

    useEffect(() => {
        setLoading(true);
        refresh();
    }, [refresh]);

    const handleRangeChange = (range: DateRange) => {
        setStartDate(range.startDate);
        setEndDate(range.endDate);
    };

    return (
        <div className="space-y-6">
            <PageHeader
                title="Funds"
                subtitle="Restricted vs unrestricted fund tracking: period activity and net assets per fund."
                actions={
                    <button
                        onClick={() => setManageOpen(true)}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors whitespace-nowrap"
                    >
                        Manage funds
                    </button>
                }
                toolbar={
                    <FilterBar
                        primary={
                            <DateRangePicker startDate={startDate} endDate={endDate} onChange={handleRangeChange} />
                        }
                    />
                }
            />

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
            ) : report && report.rows.length === 0 ? (
                <div className="bg-background-secondary/30 border border-border rounded-xl p-8 text-center">
                    <p className="text-sm text-foreground-secondary">
                        No funds yet. Create funds and assign income/expense accounts to them to see by-fund reporting.
                    </p>
                </div>
            ) : report ? (
                <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border">
                                    <th className="px-4 py-3 text-left">Fund</th>
                                    <th className="px-4 py-3 text-left">Restriction</th>
                                    <th className="px-4 py-3 text-right">Income</th>
                                    <th className="px-4 py-3 text-right">Expense</th>
                                    <th className="px-4 py-3 text-right">Net</th>
                                    <th className="px-4 py-3 text-right">Net assets</th>
                                </tr>
                            </thead>
                            <tbody>
                                {report.rows.map((row) => (
                                    <tr
                                        key={row.fundId ?? 'unassigned'}
                                        className="border-b border-border/30 last:border-b-0 hover:bg-background-secondary/20 transition-colors"
                                    >
                                        <td className="px-4 py-2.5 text-foreground">
                                            <span className={row.fundId === null ? 'text-foreground-muted italic' : ''}>{row.name}</span>
                                            {!row.active && <span className="ml-2 text-[11px] text-foreground-muted">(inactive)</span>}
                                            <span className="ml-2 text-[11px] text-foreground-muted">
                                                {row.accountCount} acct{row.accountCount === 1 ? '' : 's'}
                                            </span>
                                        </td>
                                        <td className="px-4 py-2.5">
                                            <RestrictionBadge restriction={row.restriction} />
                                        </td>
                                        <td className="px-4 py-2.5 text-right font-mono text-foreground" style={TNUM}>
                                            {formatCurrency(row.income)}
                                        </td>
                                        <td className="px-4 py-2.5 text-right font-mono text-foreground" style={TNUM}>
                                            {formatCurrency(row.expense)}
                                        </td>
                                        <td
                                            className={`px-4 py-2.5 text-right font-mono ${row.net >= 0 ? 'text-positive' : 'text-negative'}`}
                                            style={TNUM}
                                        >
                                            {formatCurrency(row.net)}
                                        </td>
                                        <td className="px-4 py-2.5 text-right font-mono text-foreground" style={TNUM}>
                                            {formatCurrency(row.netAssets)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot>
                                <tr className="border-t border-border font-medium bg-background-secondary/20">
                                    <td className="px-4 py-3 text-foreground" colSpan={2}>
                                        Total
                                    </td>
                                    <td className="px-4 py-3 text-right font-mono text-foreground" style={TNUM}>
                                        {formatCurrency(report.totals.income)}
                                    </td>
                                    <td className="px-4 py-3 text-right font-mono text-foreground" style={TNUM}>
                                        {formatCurrency(report.totals.expense)}
                                    </td>
                                    <td
                                        className={`px-4 py-3 text-right font-mono ${report.totals.net >= 0 ? 'text-positive' : 'text-negative'}`}
                                        style={TNUM}
                                    >
                                        {formatCurrency(report.totals.net)}
                                    </td>
                                    <td className="px-4 py-3 text-right font-mono text-foreground" style={TNUM}>
                                        {formatCurrency(report.totals.netAssets)}
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
            ) : null}

            <p className="text-xs text-foreground-muted">
                Income and expense cover the selected period for accounts assigned to each fund; net assets sum all
                activity through the end date. Accounts not assigned to any fund appear under “Unassigned”. Assign
                income and expense accounts to funds — assigning balance-sheet accounts as well will double count.
            </p>

            {manageOpen && (
                <ManageFundsModal
                    funds={funds}
                    onClose={() => setManageOpen(false)}
                    onChanged={refresh}
                    onAssign={(fund) => setAssignFund(fund)}
                />
            )}

            {assignFund && (
                <AssignAccountsModal
                    fund={assignFund}
                    onClose={() => setAssignFund(null)}
                    onSaved={async () => {
                        setAssignFund(null);
                        await refresh();
                    }}
                />
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Manage funds (CRUD)                                                  */
/* ------------------------------------------------------------------ */

function ManageFundsModal({
    funds,
    onClose,
    onChanged,
    onAssign,
}: {
    funds: FundView[];
    onClose: () => void;
    onChanged: () => Promise<void>;
    onAssign: (fund: FundView) => void;
}) {
    const [name, setName] = useState('');
    const [restriction, setRestriction] = useState<FundRestriction>('unrestricted');
    const [description, setDescription] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const call = async (fn: () => Promise<Response>) => {
        setBusy(true);
        setError(null);
        try {
            const res = await fn();
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error ?? `Request failed (${res.status})`);
            }
            await onChanged();
            return true;
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Request failed.');
            return false;
        } finally {
            setBusy(false);
        }
    };

    const handleCreate = async () => {
        if (!name.trim()) {
            setError('Fund name is required.');
            return;
        }
        const ok = await call(() =>
            fetch('/api/business/funds', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim(), restriction, description: description.trim() || undefined }),
            }),
        );
        if (ok) {
            setName('');
            setDescription('');
            setRestriction('unrestricted');
        }
    };

    const handleToggleActive = (fund: FundView) =>
        call(() =>
            fetch(`/api/business/funds/${fund.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active: !fund.active }),
            }),
        );

    const handleRestrictionChange = (fund: FundView, value: FundRestriction) =>
        call(() =>
            fetch(`/api/business/funds/${fund.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ restriction: value }),
            }),
        );

    const handleDelete = (fund: FundView) =>
        call(() => fetch(`/api/business/funds/${fund.id}`, { method: 'DELETE' }));

    return (
        <Modal isOpen onClose={onClose} title="Manage Funds" size="lg">
            <div className="p-6 space-y-5">
                {/* Create */}
                <div className="border border-border rounded-xl p-4 space-y-3">
                    <h3 className="text-xs font-semibold text-foreground uppercase tracking-wider">New fund</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label className={labelClass}>Name</label>
                            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Building Fund" className={inputClass} />
                        </div>
                        <div>
                            <label className={labelClass}>Restriction</label>
                            <select value={restriction} onChange={(e) => setRestriction(e.target.value as FundRestriction)} className={inputClass}>
                                <option value="unrestricted">Unrestricted</option>
                                <option value="temporarily_restricted">Temporarily restricted</option>
                                <option value="permanently_restricted">Permanently restricted</option>
                            </select>
                        </div>
                    </div>
                    <div>
                        <label className={labelClass}>Description</label>
                        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" className={inputClass} />
                    </div>
                    <div className="flex justify-end">
                        <button
                            onClick={handleCreate}
                            disabled={busy}
                            className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors disabled:opacity-50"
                        >
                            Create fund
                        </button>
                    </div>
                </div>

                {error && <p className="text-sm text-error">{error}</p>}

                {/* Existing funds */}
                {funds.length === 0 ? (
                    <p className="text-sm text-foreground-muted">No funds yet.</p>
                ) : (
                    <div className="border border-border rounded-xl overflow-hidden">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border">
                                    <th className="px-3 py-2 text-left">Fund</th>
                                    <th className="px-3 py-2 text-left">Restriction</th>
                                    <th className="px-3 py-2 text-right">Accounts</th>
                                    <th className="px-3 py-2 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {funds.map((fund) => (
                                    <tr key={fund.id} className="border-b border-border/30 last:border-b-0">
                                        <td className="px-3 py-2">
                                            <span className={fund.active ? 'text-foreground' : 'text-foreground-muted line-through'}>
                                                {fund.name}
                                            </span>
                                            {fund.description && (
                                                <span className="ml-2 text-xs text-foreground-muted">{fund.description}</span>
                                            )}
                                        </td>
                                        <td className="px-3 py-2">
                                            <select
                                                value={fund.restriction}
                                                onChange={(e) => handleRestrictionChange(fund, e.target.value as FundRestriction)}
                                                disabled={busy}
                                                className="bg-input-bg border border-border rounded px-2 py-1 text-xs text-foreground"
                                            >
                                                <option value="unrestricted">Unrestricted</option>
                                                <option value="temporarily_restricted">Temp. restricted</option>
                                                <option value="permanently_restricted">Perm. restricted</option>
                                            </select>
                                        </td>
                                        <td className="px-3 py-2 text-right font-mono text-foreground" style={TNUM}>
                                            {fund.accountGuids.length}
                                        </td>
                                        <td className="px-3 py-2 text-right whitespace-nowrap">
                                            <button
                                                onClick={() => onAssign(fund)}
                                                disabled={busy}
                                                className="text-xs text-primary hover:text-primary-hover mr-3 disabled:opacity-50"
                                            >
                                                Accounts
                                            </button>
                                            <button
                                                onClick={() => handleToggleActive(fund)}
                                                disabled={busy}
                                                className="text-xs text-foreground-secondary hover:text-foreground mr-3 disabled:opacity-50"
                                            >
                                                {fund.active ? 'Deactivate' : 'Activate'}
                                            </button>
                                            <button
                                                onClick={() => handleDelete(fund)}
                                                disabled={busy}
                                                className="text-xs text-foreground-muted hover:text-negative disabled:opacity-50"
                                                title="Delete (blocked while accounts are assigned)"
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
        </Modal>
    );
}

/* ------------------------------------------------------------------ */
/* Account assignment                                                   */
/* ------------------------------------------------------------------ */

function AssignAccountsModal({
    fund,
    onClose,
    onSaved,
}: {
    fund: FundView;
    onClose: () => void;
    onSaved: () => Promise<void>;
}) {
    const [accounts, setAccounts] = useState<FlatAccount[]>([]);
    const [selected, setSelected] = useState<Set<string>>(() => new Set(fund.accountGuids));
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/accounts?flat=true');
                if (!res.ok) throw new Error();
                const all: FlatAccount[] = await res.json();
                setAccounts(all.filter((a) => ASSIGNABLE_TYPES.has(a.account_type)));
            } catch {
                setError('Failed to load accounts.');
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    const toggle = (guid: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(guid)) next.delete(guid);
            else next.add(guid);
            return next;
        });
    };

    const handleSave = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/business/funds/${fund.id}/accounts`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accountGuids: Array.from(selected) }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error ?? `Request failed (${res.status})`);
            }
            await onSaved();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save assignments.');
            setBusy(false);
        }
    };

    return (
        <Modal isOpen onClose={onClose} title={`Accounts — ${fund.name}`} size="lg">
            <div className="p-6 space-y-4">
                <p className="text-xs text-foreground-muted">
                    Checked accounts belong to this fund. An account can belong to only one fund — checking it here
                    moves it from any other fund.
                </p>
                {loading ? (
                    <div className="py-8 text-center text-foreground-muted text-sm">Loading accounts…</div>
                ) : (
                    <div className="border border-border rounded-xl max-h-[50vh] overflow-y-auto divide-y divide-border/30">
                        {accounts.map((a) => {
                            const depth = a.fullname.split(':').length - 1;
                            return (
                                <label
                                    key={a.guid}
                                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-background-secondary/20 cursor-pointer"
                                    style={{ paddingLeft: `${12 + depth * 16}px` }}
                                >
                                    <input
                                        type="checkbox"
                                        checked={selected.has(a.guid)}
                                        onChange={() => toggle(a.guid)}
                                        className="w-4 h-4 rounded border-border-hover bg-background text-primary focus:ring-primary/50"
                                    />
                                    <span className="text-sm text-foreground truncate">{a.fullname.split(':').pop()}</span>
                                    <span className="ml-auto text-[11px] text-foreground-muted uppercase">{a.account_type}</span>
                                </label>
                            );
                        })}
                        {accounts.length === 0 && (
                            <div className="p-6 text-center text-foreground-muted text-sm">No assignable accounts found.</div>
                        )}
                    </div>
                )}
                {error && <p className="text-sm text-error">{error}</p>}
                <div className="flex justify-end gap-2">
                    <button onClick={onClose} className="px-3 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors">
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={busy || loading}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors disabled:opacity-50"
                    >
                        {busy ? 'Saving…' : `Save (${selected.size})`}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
