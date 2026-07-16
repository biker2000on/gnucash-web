'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatCurrency } from '@/lib/format';
import { PersonalToolNotice } from '@/components/PersonalToolNotice';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/contexts/ToastContext';

/* ------------------------------------------------------------------ */
/* API payload types                                                   */
/* ------------------------------------------------------------------ */

interface Allocation {
    accountGuid: string;
    amount: number;
    accountName?: string;
}

interface FundingRule {
    id: number;
    name: string;
    triggerAccountGuid: string | null;
    triggerAccountName?: string | null;
    triggerDescriptionMatch: string | null;
    minAmount: number | null;
    allocations: Allocation[];
    allocationNames?: Array<Allocation & { accountName: string }>;
    active: boolean;
    lastAppliedTxnGuid: string | null;
    updatedAt: string;
}

interface FundingApplication {
    txGuid: string;
    ruleId: number | null;
    ruleName: string | null;
    triggerTxnGuid: string | null;
    postDate: string;
    description: string;
    amount: number;
}

interface FlatAccount {
    guid: string;
    name: string;
    account_type: string;
    fullname: string;
}

interface RunResult {
    rulesScanned: number;
    depositsMatched: number;
    applied: number;
    skippedAlreadyApplied: number;
    skippedLocked: number;
    errors: string[];
}

const TNUM = { fontFeatureSettings: "'tnum'" } as const;
const TRIGGER_TYPES = new Set(['BANK', 'CASH', 'ASSET']);
const ENVELOPE_TYPES = new Set(['ASSET', 'BANK', 'CASH']);

/* ------------------------------------------------------------------ */
/* Editor form state                                                   */
/* ------------------------------------------------------------------ */

interface AllocationDraft {
    accountGuid: string;
    amount: string;
}

interface RuleDraft {
    name: string;
    triggerAccountGuid: string;
    triggerDescriptionMatch: string;
    minAmount: string;
    active: boolean;
    allocations: AllocationDraft[];
}

const EMPTY_DRAFT: RuleDraft = {
    name: '',
    triggerAccountGuid: '',
    triggerDescriptionMatch: '',
    minAmount: '',
    active: true,
    allocations: [{ accountGuid: '', amount: '' }],
};

function draftFromRule(rule: FundingRule): RuleDraft {
    return {
        name: rule.name,
        triggerAccountGuid: rule.triggerAccountGuid ?? '',
        triggerDescriptionMatch: rule.triggerDescriptionMatch ?? '',
        minAmount: rule.minAmount != null ? String(rule.minAmount) : '',
        active: rule.active,
        allocations: rule.allocations.map(a => ({
            accountGuid: a.accountGuid,
            amount: String(a.amount),
        })),
    };
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function FundingRulesPage() {
    const toast = useToast();
    const [rules, setRules] = useState<FundingRule[]>([]);
    const [applications, setApplications] = useState<FundingApplication[]>([]);
    const [accounts, setAccounts] = useState<FlatAccount[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [editorOpen, setEditorOpen] = useState(false);
    const [editingRule, setEditingRule] = useState<FundingRule | null>(null);
    const [draft, setDraft] = useState<RuleDraft>(EMPTY_DRAFT);
    const [saving, setSaving] = useState(false);
    const [running, setRunning] = useState(false);
    const [busyRuleId, setBusyRuleId] = useState<number | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/budgets/funding-rules');
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error ?? 'Failed to load funding rules');
            }
            const payload = (await res.json()) as { rules: FundingRule[]; applications: FundingApplication[] };
            setRules(payload.rules);
            setApplications(payload.applications);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        fetch('/api/accounts?flat=true&noBalances=true')
            .then(res => (res.ok ? res.json() : null))
            .then((payload: { accounts?: FlatAccount[] } | FlatAccount[] | null) => {
                if (!payload) return;
                const list = Array.isArray(payload) ? payload : payload.accounts ?? [];
                setAccounts(list);
            })
            .catch(() => { /* pickers stay empty */ });
    }, []);

    const triggerAccounts = useMemo(
        () => accounts.filter(a => TRIGGER_TYPES.has(a.account_type)),
        [accounts],
    );
    const envelopeAccounts = useMemo(
        () => accounts.filter(a => ENVELOPE_TYPES.has(a.account_type)),
        [accounts],
    );

    const openCreate = () => {
        setEditingRule(null);
        setDraft(EMPTY_DRAFT);
        setEditorOpen(true);
    };

    const openEdit = (rule: FundingRule) => {
        setEditingRule(rule);
        setDraft(draftFromRule(rule));
        setEditorOpen(true);
    };

    const saveRule = async () => {
        const allocations = draft.allocations
            .filter(a => a.accountGuid && a.amount.trim() !== '')
            .map(a => ({ accountGuid: a.accountGuid, amount: parseFloat(a.amount) }));
        if (draft.name.trim() === '') { toast.error('Give the rule a name'); return; }
        if (!draft.triggerAccountGuid) { toast.error('Pick the bank account the deposit lands in'); return; }
        if (allocations.length === 0) { toast.error('Add at least one envelope allocation'); return; }

        setSaving(true);
        try {
            const body = {
                name: draft.name.trim(),
                triggerAccountGuid: draft.triggerAccountGuid,
                triggerDescriptionMatch: draft.triggerDescriptionMatch.trim() || null,
                minAmount: draft.minAmount.trim() === '' ? null : parseFloat(draft.minAmount),
                allocations,
                active: draft.active,
            };
            const res = await fetch(
                editingRule ? `/api/budgets/funding-rules/${editingRule.id}` : '/api/budgets/funding-rules',
                {
                    method: editingRule ? 'PATCH' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                },
            );
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                throw new Error(payload?.error ?? 'Failed to save rule');
            }
            toast.success(editingRule ? 'Rule updated' : 'Rule created');
            setEditorOpen(false);
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to save rule');
        } finally {
            setSaving(false);
        }
    };

    const toggleActive = async (rule: FundingRule) => {
        setBusyRuleId(rule.id);
        try {
            const res = await fetch(`/api/budgets/funding-rules/${rule.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active: !rule.active }),
            });
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                throw new Error(payload?.error ?? 'Failed to update rule');
            }
            setRules(prev => prev.map(r => (r.id === rule.id ? { ...r, active: !rule.active } : r)));
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to update rule');
        } finally {
            setBusyRuleId(null);
        }
    };

    const deleteRule = async (rule: FundingRule) => {
        if (!window.confirm(`Delete funding rule "${rule.name}"? Past sweep transactions stay in the ledger.`)) return;
        setBusyRuleId(rule.id);
        try {
            const res = await fetch(`/api/budgets/funding-rules/${rule.id}`, { method: 'DELETE' });
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                throw new Error(payload?.error ?? 'Failed to delete rule');
            }
            toast.success('Rule deleted');
            setRules(prev => prev.filter(r => r.id !== rule.id));
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to delete rule');
        } finally {
            setBusyRuleId(null);
        }
    };

    const runNow = async () => {
        setRunning(true);
        try {
            const res = await fetch('/api/budgets/funding-rules/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sinceDays: 7 }),
            });
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                throw new Error(payload?.error ?? 'Run failed');
            }
            const result = (await res.json()) as RunResult;
            if (result.applied > 0) {
                toast.success(`Applied ${result.applied} sweep${result.applied === 1 ? '' : 's'}`);
            } else if (result.errors.length > 0) {
                toast.error(result.errors[0]);
            } else {
                toast.success(
                    `No new sweeps — ${result.depositsMatched} match(es), ` +
                    `${result.skippedAlreadyApplied} already applied` +
                    (result.skippedLocked > 0 ? `, ${result.skippedLocked} period-locked` : ''),
                );
            }
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Run failed');
        } finally {
            setRunning(false);
        }
    };

    const setAllocation = (index: number, patch: Partial<AllocationDraft>) => {
        setDraft(prev => ({
            ...prev,
            allocations: prev.allocations.map((a, i) => (i === index ? { ...a, ...patch } : a)),
        }));
    };

    const draftTotal = useMemo(
        () => draft.allocations.reduce((sum, a) => sum + (parseFloat(a.amount) || 0), 0),
        [draft.allocations],
    );

    return (
        <div className="space-y-6">
            <header className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="text-3xl font-bold text-foreground">Auto-Funding Rules</h1>
                    <p className="text-foreground-muted mt-1">
                        When a paycheck or deposit lands, sweep fixed amounts into envelope accounts automatically.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={runNow}
                        disabled={running || loading}
                        className="px-4 py-2 border border-border text-foreground-secondary hover:text-foreground hover:border-border-hover text-sm rounded-lg transition-colors disabled:opacity-50"
                    >
                        {running ? 'Running…' : 'Run now'}
                    </button>
                    <button
                        type="button"
                        onClick={openCreate}
                        className="px-4 py-2 bg-primary hover:bg-primary-hover text-primary-foreground text-sm rounded-lg transition-colors"
                    >
                        New rule
                    </button>
                </div>
            </header>

            <PersonalToolNotice />

            <section className="bg-surface/30 border border-border rounded-xl p-4 text-sm text-foreground-secondary">
                <p>
                    <span className="text-foreground font-medium">How it works:</span>{' '}
                    create envelope sub-accounts under your savings (e.g.{' '}
                    <span className="font-mono text-xs">Assets:Savings:Vacation</span>,{' '}
                    <span className="font-mono text-xs">Assets:Savings:Car Repairs</span>). A rule watches a bank
                    account for deposits — matched by description and a minimum amount — and when one lands, it
                    creates a real double-entry transfer that sweeps your chosen amounts from the bank account
                    into each envelope, dated the same day. The worker checks every 30 minutes; each deposit is
                    swept at most once per rule, and transfers into locked periods are skipped.
                </p>
            </section>

            {loading && (
                <section className="bg-surface/30 border border-border rounded-xl p-6 animate-pulse">
                    <div className="h-4 bg-foreground-muted/20 rounded w-48 mb-3" />
                    <div className="h-4 bg-foreground-muted/20 rounded w-72" />
                </section>
            )}

            {!loading && error && (
                <section className="bg-surface/30 border border-error/30 rounded-xl p-6">
                    <p className="text-sm text-error">{error}</p>
                </section>
            )}

            {/* Rules list */}
            {!loading && !error && (
                <section className="bg-surface/30 border border-border rounded-xl p-6">
                    <h2 className="text-sm font-semibold text-foreground mb-4">Rules</h2>
                    {rules.length === 0 ? (
                        <p className="text-sm text-foreground-muted py-6 text-center">
                            No funding rules yet. Create one to start sweeping deposits into envelopes.
                        </p>
                    ) : (
                        <div className="space-y-3">
                            {rules.map(rule => {
                                const allocs = rule.allocationNames ?? rule.allocations;
                                const total = rule.allocations.reduce((s, a) => s + a.amount, 0);
                                return (
                                    <div
                                        key={rule.id}
                                        className={`border border-border rounded-lg p-4 ${rule.active ? '' : 'opacity-60'}`}
                                    >
                                        <div className="flex flex-wrap items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <span className="font-medium text-foreground">{rule.name}</span>
                                                    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                                                        rule.active
                                                            ? 'text-primary border-primary/40 bg-primary-light'
                                                            : 'text-foreground-muted border-border'
                                                    }`}>
                                                        {rule.active ? 'Active' : 'Paused'}
                                                    </span>
                                                </div>
                                                <p className="text-xs text-foreground-muted mt-1">
                                                    Deposits into{' '}
                                                    <span className="text-foreground-secondary">{rule.triggerAccountName ?? '—'}</span>
                                                    {rule.triggerDescriptionMatch
                                                        ? <> matching <span className="font-mono">&quot;{rule.triggerDescriptionMatch}&quot;</span></>
                                                        : ' (any description)'}
                                                    {rule.minAmount != null && <> of at least <span className="font-mono" style={TNUM}>{formatCurrency(rule.minAmount)}</span></>}
                                                </p>
                                                <ul className="mt-2 space-y-0.5">
                                                    {allocs.map(a => (
                                                        <li key={a.accountGuid} className="text-xs text-foreground-secondary flex items-center gap-2">
                                                            <span className="text-foreground-muted">→</span>
                                                            <span className="truncate">{'accountName' in a && a.accountName ? a.accountName : a.accountGuid}</span>
                                                            <span className="font-mono text-foreground" style={TNUM}>{formatCurrency(a.amount)}</span>
                                                        </li>
                                                    ))}
                                                </ul>
                                                <p className="text-xs text-foreground-muted mt-2">
                                                    Sweeps <span className="font-mono text-foreground-secondary" style={TNUM}>{formatCurrency(total)}</span> per matching deposit
                                                    {rule.lastAppliedTxnGuid && <> · last applied to deposit <span className="font-mono">{rule.lastAppliedTxnGuid.slice(0, 8)}</span></>}
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-2 shrink-0">
                                                <button
                                                    type="button"
                                                    onClick={() => toggleActive(rule)}
                                                    disabled={busyRuleId === rule.id}
                                                    className="px-3 py-1.5 text-xs border border-border rounded-lg text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors disabled:opacity-50"
                                                >
                                                    {rule.active ? 'Pause' : 'Activate'}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => openEdit(rule)}
                                                    className="px-3 py-1.5 text-xs border border-border rounded-lg text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors"
                                                >
                                                    Edit
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => deleteRule(rule)}
                                                    disabled={busyRuleId === rule.id}
                                                    className="px-3 py-1.5 text-xs border border-error/30 rounded-lg text-error hover:bg-error/10 transition-colors disabled:opacity-50"
                                                >
                                                    Delete
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </section>
            )}

            {/* Application history */}
            {!loading && !error && (
                <section className="bg-surface/30 border border-border rounded-xl p-6">
                    <h2 className="text-sm font-semibold text-foreground mb-4">Recent applications</h2>
                    {applications.length === 0 ? (
                        <p className="text-sm text-foreground-muted py-4 text-center">
                            No sweeps yet. When a rule fires you&apos;ll see the transfer here (and in the account ledger).
                        </p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-[10px] uppercase tracking-wider text-foreground-muted border-b border-border">
                                        <th className="py-2 pr-4 font-medium">Date</th>
                                        <th className="py-2 pr-4 font-medium">Rule</th>
                                        <th className="py-2 pr-4 font-medium">Transfer</th>
                                        <th className="py-2 text-right font-medium">Amount</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {applications.map(app => (
                                        <tr key={app.txGuid} className="border-b border-border/50">
                                            <td className="py-2 pr-4 font-mono text-xs text-foreground-secondary" style={TNUM}>{app.postDate}</td>
                                            <td className="py-2 pr-4 text-foreground-secondary">{app.ruleName ?? (app.ruleId != null ? `Rule #${app.ruleId}` : '—')}</td>
                                            <td className="py-2 pr-4 text-foreground-secondary truncate max-w-[280px]">{app.description}</td>
                                            <td className="py-2 text-right font-mono text-foreground" style={TNUM}>{formatCurrency(app.amount)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </section>
            )}

            {/* Editor modal */}
            <Modal
                isOpen={editorOpen}
                onClose={() => setEditorOpen(false)}
                title={editingRule ? 'Edit funding rule' : 'New funding rule'}
                size="lg"
            >
                <div className="p-6 space-y-4">
                    <div>
                        <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1">Rule name</label>
                        <input
                            type="text"
                            value={draft.name}
                            onChange={e => setDraft(prev => ({ ...prev, name: e.target.value }))}
                            placeholder="Paycheck split"
                            className="w-full bg-input-bg border border-border rounded-lg py-2 px-3 text-sm text-foreground focus:outline-none focus:border-primary/50"
                        />
                    </div>

                    <div>
                        <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1">Deposit lands in (bank account)</label>
                        <select
                            value={draft.triggerAccountGuid}
                            onChange={e => setDraft(prev => ({ ...prev, triggerAccountGuid: e.target.value }))}
                            className="w-full bg-input-bg border border-border rounded-lg py-2 px-3 text-sm text-foreground focus:outline-none focus:border-primary/50"
                        >
                            <option value="">Select account…</option>
                            {triggerAccounts.map(a => (
                                <option key={a.guid} value={a.guid}>{a.fullname || a.name}</option>
                            ))}
                        </select>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1">Description contains</label>
                            <input
                                type="text"
                                value={draft.triggerDescriptionMatch}
                                onChange={e => setDraft(prev => ({ ...prev, triggerDescriptionMatch: e.target.value }))}
                                placeholder="ACME PAYROLL (empty = any deposit)"
                                className="w-full bg-input-bg border border-border rounded-lg py-2 px-3 text-sm text-foreground focus:outline-none focus:border-primary/50"
                            />
                        </div>
                        <div>
                            <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1">Minimum amount</label>
                            <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={draft.minAmount}
                                onChange={e => setDraft(prev => ({ ...prev, minAmount: e.target.value }))}
                                placeholder="No minimum"
                                className="w-full bg-input-bg border border-border rounded-lg py-2 px-3 text-sm text-foreground font-mono focus:outline-none focus:border-primary/50"
                                style={TNUM}
                            />
                        </div>
                    </div>

                    <div>
                        <div className="flex items-center justify-between mb-1">
                            <label className="block text-xs uppercase tracking-wider text-foreground-muted">Envelope allocations</label>
                            <span className="text-xs text-foreground-muted">
                                Total <span className="font-mono text-foreground-secondary" style={TNUM}>{formatCurrency(draftTotal)}</span>
                            </span>
                        </div>
                        <div className="space-y-2">
                            {draft.allocations.map((alloc, i) => (
                                <div key={i} className="flex items-center gap-2">
                                    <select
                                        value={alloc.accountGuid}
                                        onChange={e => setAllocation(i, { accountGuid: e.target.value })}
                                        className="flex-1 min-w-0 bg-input-bg border border-border rounded-lg py-2 px-3 text-sm text-foreground focus:outline-none focus:border-primary/50"
                                    >
                                        <option value="">Envelope account…</option>
                                        {envelopeAccounts
                                            .filter(a => a.guid !== draft.triggerAccountGuid)
                                            .map(a => (
                                                <option key={a.guid} value={a.guid}>{a.fullname || a.name}</option>
                                            ))}
                                    </select>
                                    <input
                                        type="number"
                                        min="0.01"
                                        step="0.01"
                                        value={alloc.amount}
                                        onChange={e => setAllocation(i, { amount: e.target.value })}
                                        placeholder="0.00"
                                        className="w-28 bg-input-bg border border-border rounded-lg py-2 px-3 text-sm text-foreground font-mono text-right focus:outline-none focus:border-primary/50"
                                        style={TNUM}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setDraft(prev => ({
                                            ...prev,
                                            allocations: prev.allocations.filter((_, idx) => idx !== i),
                                        }))}
                                        disabled={draft.allocations.length === 1}
                                        aria-label="Remove allocation"
                                        className="p-2 text-foreground-muted hover:text-error transition-colors disabled:opacity-30"
                                    >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                        </svg>
                                    </button>
                                </div>
                            ))}
                        </div>
                        <button
                            type="button"
                            onClick={() => setDraft(prev => ({
                                ...prev,
                                allocations: [...prev.allocations, { accountGuid: '', amount: '' }],
                            }))}
                            className="mt-2 text-xs text-primary hover:text-primary-hover transition-colors"
                        >
                            + Add envelope
                        </button>
                        <p className="text-xs text-foreground-muted mt-2">
                            Envelopes are real asset sub-accounts (same currency as the bank account). Create them
                            under Savings first if they don&apos;t exist yet.
                        </p>
                    </div>

                    <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                        <input
                            type="checkbox"
                            checked={draft.active}
                            onChange={e => setDraft(prev => ({ ...prev, active: e.target.checked }))}
                            className="accent-[var(--primary)]"
                        />
                        Rule is active
                    </label>

                    <div className="flex justify-end gap-2 pt-2 border-t border-border">
                        <button
                            type="button"
                            onClick={() => setEditorOpen(false)}
                            className="px-4 py-2 border border-border text-foreground-secondary hover:text-foreground text-sm rounded-lg transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={saveRule}
                            disabled={saving}
                            className="px-4 py-2 bg-primary hover:bg-primary-hover text-primary-foreground text-sm rounded-lg transition-colors disabled:opacity-50"
                        >
                            {saving ? 'Saving…' : editingRule ? 'Save changes' : 'Create rule'}
                        </button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}
