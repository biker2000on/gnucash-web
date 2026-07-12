'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { formatCurrency } from '@/lib/format';
import type {
    EmergencyPackage,
    EmergencyAccountEntry,
    BookEmergencySections,
} from '@/lib/emergency-info';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

const TYPE_LABELS: Record<string, string> = {
    BANK: 'Bank',
    ASSET: 'Asset',
    STOCK: 'Investment',
    MUTUAL: 'Fund',
    LIABILITY: 'Loan',
    CREDIT: 'Credit card',
};

const SECTION_FIELDS: Array<{ key: keyof BookEmergencySections; label: string; placeholder: string }> = [
    { key: 'executor', label: 'Executor / Emergency contact', placeholder: 'Name, relationship, phone, email…' },
    { key: 'attorney', label: 'Attorney / Estate documents', placeholder: 'Estate attorney, where the will and POA are stored…' },
    { key: 'insurance', label: 'Insurance policies', placeholder: 'Life, home, auto, umbrella — carrier, policy number, agent phone…' },
    { key: 'instructions', label: 'Instructions', placeholder: 'What to do first, bills on autopay, safe deposit box, passwords location…' },
];

interface AccountDraft {
    institution: string;
    beneficiary: string;
    contact: string;
    loginHint: string;
    notes: string;
}

function draftFromEntry(entry: EmergencyAccountEntry): AccountDraft {
    return {
        institution: entry.institutionSource === 'metadata' ? entry.institution : '',
        beneficiary: entry.beneficiary ?? '',
        contact: entry.contact ?? '',
        loginHint: entry.loginHint ?? '',
        notes: entry.notes ?? '',
    };
}

function balanceClass(value: number): string {
    if (value > 0) return 'text-positive';
    if (value < 0) return 'text-negative';
    return 'text-foreground-secondary';
}

export default function EmergencyPackagePage() {
    const [pkg, setPkg] = useState<EmergencyPackage | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [mode, setMode] = useState<'view' | 'edit'>('view');

    const [drafts, setDrafts] = useState<Record<string, AccountDraft>>({});
    const [dirtyAccounts, setDirtyAccounts] = useState<Set<string>>(new Set());
    const [sections, setSections] = useState<BookEmergencySections>({
        executor: '', attorney: '', insurance: '', instructions: '',
    });
    const [sectionsDirty, setSectionsDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/tools/emergency');
            if (!res.ok) throw new Error((await res.json()).error || 'Failed to load emergency package');
            const data: EmergencyPackage = await res.json();
            setPkg(data);
            setSections(data.sections);
            const nextDrafts: Record<string, AccountDraft> = {};
            for (const entry of data.accounts) nextDrafts[entry.guid] = draftFromEntry(entry);
            setDrafts(nextDrafts);
            setDirtyAccounts(new Set());
            setSectionsDirty(false);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load emergency package');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const hasDirty = dirtyAccounts.size > 0 || sectionsDirty;

    const updateDraft = (guid: string, field: keyof AccountDraft, value: string) => {
        setDrafts(prev => ({ ...prev, [guid]: { ...prev[guid], [field]: value } }));
        setDirtyAccounts(prev => new Set(prev).add(guid));
    };

    const saveAll = async () => {
        setSaving(true);
        setSaveError(null);
        try {
            if (sectionsDirty) {
                const res = await fetch('/api/tools/emergency', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sections }),
                });
                if (!res.ok) throw new Error((await res.json()).error || 'Failed to save sections');
            }
            for (const guid of dirtyAccounts) {
                const draft = drafts[guid];
                if (!draft) continue;
                const res = await fetch(`/api/tools/emergency/${guid}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(draft),
                });
                if (!res.ok) throw new Error((await res.json()).error || 'Failed to save account info');
            }
            await load();
        } catch (err) {
            setSaveError(err instanceof Error ? err.message : 'Failed to save');
        } finally {
            setSaving(false);
        }
    };

    const handlePrint = () => {
        setMode('view');
        // Give React a frame to render the view before the print dialog opens.
        setTimeout(() => window.print(), 150);
    };

    const asOfLabel = useMemo(() => (
        pkg ? new Date(pkg.asOf).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : ''
    ), [pkg]);

    const nonEmptySections = SECTION_FIELDS.filter(f => (pkg?.sections[f.key] ?? '').trim() !== '');

    if (loading) {
        return (
            <div className="space-y-6">
                <div className="h-8 bg-background-tertiary rounded animate-pulse w-64" />
                <div className="h-24 bg-background-tertiary rounded-lg animate-pulse" />
                <div className="h-96 bg-background-tertiary rounded-lg animate-pulse" />
            </div>
        );
    }

    if (error || !pkg) {
        return (
            <div className="space-y-6">
                <PageHeader title="In Case of Emergency" subtitle="Printable account package for your family" />
                <div className="bg-surface border border-border rounded-lg p-8 text-center">
                    <p className="text-negative">{error ?? 'Failed to load emergency package'}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Print CSS: only the document itself prints, in plain black on white. */}
            <style>{`
                @media print {
                    body * { visibility: hidden; }
                    #emergency-print, #emergency-print * { visibility: visible; }
                    #emergency-print {
                        position: absolute; left: 0; top: 0; width: 100%;
                        margin: 0; padding: 0;
                    }
                    #emergency-print, #emergency-print * {
                        color: #000 !important;
                        background: transparent !important;
                        border-color: #94a3b8 !important;
                        box-shadow: none !important;
                    }
                    #emergency-print .print-warning {
                        border: 2px solid #000 !important;
                    }
                    #emergency-print table { page-break-inside: auto; }
                    #emergency-print tr { page-break-inside: avoid; }
                }
            `}</style>

            <PageHeader
                title="In Case of Emergency"
                subtitle="A printable package of accounts, balances, beneficiaries, and instructions"
                actions={
                    <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1">
                            <button
                                onClick={() => setMode('view')}
                                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                                    mode === 'view'
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
                                }`}
                            >
                                Document
                            </button>
                            <button
                                onClick={() => setMode('edit')}
                                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                                    mode === 'edit'
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
                                }`}
                            >
                                Edit info
                            </button>
                        </div>
                        {mode === 'edit' && (
                            <button
                                onClick={saveAll}
                                disabled={!hasDirty || saving}
                                className="px-3 py-1.5 text-xs font-medium rounded bg-primary text-primary-foreground disabled:opacity-40 transition-colors"
                            >
                                {saving ? 'Saving…' : 'Save changes'}
                            </button>
                        )}
                        <button
                            onClick={handlePrint}
                            className="px-3 py-1.5 text-xs font-medium rounded border border-border text-foreground-secondary hover:bg-surface-hover transition-colors"
                        >
                            Print
                        </button>
                    </div>
                }
            />

            {saveError && (
                <div className="bg-error/10 border border-error/40 rounded-lg px-4 py-2.5 text-sm text-negative">
                    {saveError}
                </div>
            )}

            {mode === 'edit' ? (
                <EditMode
                    pkg={pkg}
                    drafts={drafts}
                    updateDraft={updateDraft}
                    sections={sections}
                    setSections={(next) => { setSections(next); setSectionsDirty(true); }}
                />
            ) : (
                <div id="emergency-print" className="space-y-6">
                    {/* Security warning */}
                    <div className="print-warning bg-warning/10 border border-warning/50 rounded-lg px-4 py-3">
                        <p className="text-sm font-semibold text-foreground">
                            Store printed copies securely.
                        </p>
                        <p className="text-xs text-foreground-secondary mt-1">
                            This document lists every account your family would need in an emergency —
                            institutions, balances, beneficiaries, and where to find logins. Keep it in a
                            safe, fireproof box, or with your attorney. Do not carry it, email it, or leave
                            it unsecured. Reprint it after significant account changes.
                        </p>
                    </div>

                    {/* Document header */}
                    <div>
                        <h2 className="text-2xl font-bold text-foreground">In Case of Emergency — Financial Accounts</h2>
                        <p className="text-sm text-foreground-secondary mt-1">
                            Balances as of <span className="font-mono" style={TNUM}>{asOfLabel}</span>
                        </p>
                    </div>

                    {/* Totals */}
                    <div className="grid grid-cols-3 gap-3">
                        <div className="bg-surface/30 border border-border rounded-lg px-3 py-2">
                            <div className="text-[10px] uppercase tracking-wider text-foreground-muted">Assets</div>
                            <div className="font-mono font-semibold text-positive text-lg" style={TNUM}>
                                {formatCurrency(pkg.totals.assets)}
                            </div>
                        </div>
                        <div className="bg-surface/30 border border-border rounded-lg px-3 py-2">
                            <div className="text-[10px] uppercase tracking-wider text-foreground-muted">Liabilities</div>
                            <div className="font-mono font-semibold text-negative text-lg" style={TNUM}>
                                {formatCurrency(pkg.totals.liabilities)}
                            </div>
                        </div>
                        <div className="bg-surface/30 border border-border rounded-lg px-3 py-2">
                            <div className="text-[10px] uppercase tracking-wider text-foreground-muted">Net</div>
                            <div className="font-mono font-semibold text-foreground text-lg" style={TNUM}>
                                {formatCurrency(pkg.totals.net)}
                            </div>
                        </div>
                    </div>

                    {/* Book-level sections */}
                    {nonEmptySections.length > 0 && (
                        <div className="grid gap-4 sm:grid-cols-2">
                            {nonEmptySections.map(f => (
                                <div key={f.key} className="bg-surface border border-border rounded-lg p-4">
                                    <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground-muted mb-2">
                                        {f.label}
                                    </h3>
                                    <p className="text-sm text-foreground whitespace-pre-wrap">{pkg.sections[f.key]}</p>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Accounts by institution */}
                    {pkg.institutions.length === 0 ? (
                        <div className="bg-surface border border-border rounded-lg p-8 text-center">
                            <p className="text-foreground-secondary">No accounts with balances found in this book.</p>
                        </div>
                    ) : pkg.institutions.map(group => (
                        <div key={group.institution} className="bg-surface border border-border rounded-lg overflow-hidden">
                            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-background-secondary">
                                <h3 className="text-sm font-semibold text-foreground">{group.institution}</h3>
                                <span className="text-sm font-mono font-semibold text-foreground" style={TNUM}>
                                    {formatCurrency(group.subtotal)}
                                </span>
                            </div>
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="text-left text-[11px] uppercase tracking-wider text-foreground-muted border-b border-border">
                                            <th className="px-4 py-2 font-medium">Account</th>
                                            <th className="px-4 py-2 font-medium">Type</th>
                                            <th className="px-4 py-2 font-medium text-right">Balance</th>
                                            <th className="px-4 py-2 font-medium">Beneficiary</th>
                                            <th className="px-4 py-2 font-medium">Contact / Phone</th>
                                            <th className="px-4 py-2 font-medium">Logins</th>
                                            <th className="px-4 py-2 font-medium">Notes</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {group.accounts.map(account => (
                                            <tr key={account.guid} className="border-b border-border last:border-b-0 align-top">
                                                <td className="px-4 py-2">
                                                    <div className="text-foreground font-medium">{account.name}</div>
                                                    <div className="text-xs text-foreground-muted">{account.path}</div>
                                                </td>
                                                <td className="px-4 py-2 text-foreground-secondary whitespace-nowrap">
                                                    {TYPE_LABELS[account.accountType] ?? account.accountType}
                                                </td>
                                                <td className={`px-4 py-2 text-right font-mono whitespace-nowrap ${balanceClass(account.balance)}`} style={TNUM}>
                                                    {formatCurrency(account.balance, account.currency ?? 'USD')}
                                                </td>
                                                <td className="px-4 py-2 text-foreground-secondary">{account.beneficiary ?? '—'}</td>
                                                <td className="px-4 py-2 text-foreground-secondary">{account.contact ?? '—'}</td>
                                                <td className="px-4 py-2 text-foreground-secondary">{account.loginHint ?? '—'}</td>
                                                <td className="px-4 py-2 text-foreground-secondary">{account.notes ?? '—'}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    ))}

                    <p className="text-xs text-foreground-muted">
                        Generated by GnuCash Web on <span className="font-mono" style={TNUM}>{asOfLabel}</span>.
                        Accounts with a zero balance and no recorded emergency info are omitted.
                    </p>
                </div>
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Edit mode                                                           */
/* ------------------------------------------------------------------ */

function EditMode({
    pkg,
    drafts,
    updateDraft,
    sections,
    setSections,
}: {
    pkg: EmergencyPackage;
    drafts: Record<string, AccountDraft>;
    updateDraft: (guid: string, field: keyof AccountDraft, value: string) => void;
    sections: BookEmergencySections;
    setSections: (next: BookEmergencySections) => void;
}) {
    const inputClass =
        'w-full bg-transparent border border-border rounded px-2 py-1 text-xs text-foreground ' +
        'placeholder-foreground-muted focus:outline-none focus:border-primary/60';

    return (
        <div className="space-y-6">
            {/* Book-level sections */}
            <div className="grid gap-4 sm:grid-cols-2">
                {SECTION_FIELDS.map(f => (
                    <div key={f.key} className="bg-surface border border-border rounded-lg p-4">
                        <label className="block text-xs font-semibold uppercase tracking-wider text-foreground-muted mb-2">
                            {f.label}
                        </label>
                        <textarea
                            value={sections[f.key]}
                            onChange={e => setSections({ ...sections, [f.key]: e.target.value })}
                            placeholder={f.placeholder}
                            rows={4}
                            className="w-full bg-transparent border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/60 resize-y"
                        />
                    </div>
                ))}
            </div>

            {/* Per-account table */}
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
                <div className="px-4 py-2.5 border-b border-border bg-background-secondary">
                    <h3 className="text-sm font-semibold text-foreground">Account emergency info</h3>
                    <p className="text-xs text-foreground-muted mt-0.5">
                        Institution defaults to the account&apos;s top-level parent; fill it in to override
                        the grouping. Zero-balance accounts print only when they carry info.
                    </p>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[960px]">
                        <thead>
                            <tr className="text-left text-[11px] uppercase tracking-wider text-foreground-muted border-b border-border">
                                <th className="px-4 py-2 font-medium">Account</th>
                                <th className="px-4 py-2 font-medium text-right">Balance</th>
                                <th className="px-3 py-2 font-medium w-40">Institution</th>
                                <th className="px-3 py-2 font-medium w-40">Beneficiary</th>
                                <th className="px-3 py-2 font-medium w-40">Contact / Phone</th>
                                <th className="px-3 py-2 font-medium w-36">Logins (e.g. 1Password)</th>
                                <th className="px-3 py-2 font-medium w-44">Notes</th>
                            </tr>
                        </thead>
                        <tbody>
                            {pkg.accounts.map(account => {
                                const draft = drafts[account.guid] ?? draftFromEntry(account);
                                return (
                                    <tr
                                        key={account.guid}
                                        className={`border-b border-border last:border-b-0 align-top ${account.included ? '' : 'opacity-60'}`}
                                    >
                                        <td className="px-4 py-2">
                                            <div className="text-foreground font-medium whitespace-nowrap">{account.name}</div>
                                            <div className="text-xs text-foreground-muted whitespace-nowrap">{account.path}</div>
                                        </td>
                                        <td className={`px-4 py-2 text-right font-mono whitespace-nowrap ${balanceClass(account.balance)}`} style={TNUM}>
                                            {formatCurrency(account.balance, account.currency ?? 'USD')}
                                        </td>
                                        <td className="px-3 py-2">
                                            <input
                                                type="text"
                                                value={draft.institution}
                                                placeholder={account.institutionSource === 'hierarchy' ? account.institution : ''}
                                                onChange={e => updateDraft(account.guid, 'institution', e.target.value)}
                                                className={inputClass}
                                            />
                                        </td>
                                        <td className="px-3 py-2">
                                            <input
                                                type="text"
                                                value={draft.beneficiary}
                                                onChange={e => updateDraft(account.guid, 'beneficiary', e.target.value)}
                                                className={inputClass}
                                            />
                                        </td>
                                        <td className="px-3 py-2">
                                            <input
                                                type="text"
                                                value={draft.contact}
                                                onChange={e => updateDraft(account.guid, 'contact', e.target.value)}
                                                className={inputClass}
                                            />
                                        </td>
                                        <td className="px-3 py-2">
                                            <input
                                                type="text"
                                                value={draft.loginHint}
                                                onChange={e => updateDraft(account.guid, 'loginHint', e.target.value)}
                                                className={inputClass}
                                            />
                                        </td>
                                        <td className="px-3 py-2">
                                            <input
                                                type="text"
                                                value={draft.notes}
                                                onChange={e => updateDraft(account.guid, 'notes', e.target.value)}
                                                className={inputClass}
                                            />
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
