'use client';

/**
 * Settlement import page: processor payout CSVs (Stripe / Square / PayPal /
 * Shopify) → gross/fee/net accounting in the ACTIVE book. Steps: source +
 * upload → mapping/preview → commit → result. Follows the personal-import
 * wizard's visual patterns.
 */

import { useState, useRef, useCallback } from 'react';
import Link from 'next/link';

type SettlementSource = 'stripe' | 'square' | 'paypal' | 'shopify';
type SettlementRole = 'income' | 'fees' | 'clearing' | 'bank';
type SettlementKind = 'sale' | 'refund' | 'fee_only' | 'payout' | 'other';

interface RoleResolution {
    role: SettlementRole;
    targetGuid: string | null;
    path: string;
    accountType: string;
    isNew: boolean;
    mapped: boolean;
    used: boolean;
}

interface AccountOption {
    guid: string;
    path: string;
    type: string;
}

interface PreviewData {
    source: SettlementSource;
    transactionCount: number;
    rowsRead: number;
    errorCount: number;
    duplicateCount: number;
    lockedCount: number;
    lockDate: string | null;
    statusSkipped: number;
    ambiguousDateRows: number;
    dateRange: { start: string; end: string } | null;
    kindCounts: Record<SettlementKind, number>;
    totals: { gross: number; fees: number; net: number };
    payoutTotal: number;
    clearingProjection: number;
    accounts: RoleResolution[];
    accountOptions: Record<SettlementRole, AccountOption[]>;
    errors: Array<{ row: number; message: string }>;
    warnings: string[];
    sampleTransactions: Array<{
        date: string;
        kind: SettlementKind;
        description: string;
        gross: number;
        fee: number;
        net: number;
        reference: string;
    }>;
    skippedDuplicates: Array<{
        row: number;
        date: string;
        net: number;
        description: string;
        reference: string;
    }>;
}

interface CommitResult {
    accountsCreated: number;
    transactionsCreated: number;
    splitsCreated: number;
    duplicatesSkipped: number;
    lockedSkipped: number;
    errorRows: number;
    warnings: string[];
    clearingAccountPath: string;
}

const SOURCES: Array<{ value: SettlementSource; label: string; hint: string }> = [
    {
        value: 'stripe',
        label: 'Stripe',
        hint: 'Balance report CSV (Reports → Balance → Export) — Type, Amount, Fee, Net per balance transaction, including payouts.',
    },
    {
        value: 'square',
        label: 'Square',
        hint: 'Transactions CSV (Dashboard → Transactions → Export) — Gross Sales, Tax, Tip, Fees, Net Total, Transaction ID.',
    },
    {
        value: 'paypal',
        label: 'PayPal',
        hint: 'Activity download CSV (Activity → Download) — Type, Status, Gross, Fee, Net. Only Completed rows import.',
    },
    {
        value: 'shopify',
        label: 'Shopify',
        hint: 'Payout transactions CSV (Finances → Payouts → Export) — Type (charge/refund/payout), Amount, Fee, Net.',
    },
];

const ROLE_LABELS: Record<SettlementRole, { title: string; help: string }> = {
    income: { title: 'Income (gross sales)', help: 'Credited with the gross amount of each sale; refunds debit it (contra income).' },
    fees: { title: 'Processing fees', help: 'Expense account debited with the processor fee on each sale.' },
    clearing: { title: 'Processor clearing account', help: 'Holds the net of each sale until the payout moves it to the bank. Nets toward zero.' },
    bank: { title: 'Bank account (payouts)', help: 'Debited when a payout row moves money out of the processor balance.' },
};

const KIND_LABELS: Record<SettlementKind, string> = {
    sale: 'Sales',
    refund: 'Refunds',
    fee_only: 'Fees',
    payout: 'Payouts',
    other: 'Other',
};

const fmtAmount = (n: number) =>
    n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function SettlementImportPage() {
    const [source, setSource] = useState<SettlementSource>('stripe');
    const [file, setFile] = useState<File | null>(null);
    const [dragOver, setDragOver] = useState(false);
    const [locale, setLocale] = useState<'us' | 'eu'>('us');
    const [mappings, setMappings] = useState<Partial<Record<SettlementRole, string>>>({});
    const [skipDuplicates, setSkipDuplicates] = useState(true);

    const [preview, setPreview] = useState<PreviewData | null>(null);
    const [previewing, setPreviewing] = useState(false);
    const [importing, setImporting] = useState(false);
    const [result, setResult] = useState<CommitResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    const inputRef = useRef<HTMLInputElement>(null);

    const handleFile = useCallback((f: File) => {
        setFile(f);
        setPreview(null);
        setResult(null);
        setError(null);
        setMappings({});
    }, []);

    const handleSource = useCallback((s: SettlementSource) => {
        setSource(s);
        setPreview(null);
        setResult(null);
        setError(null);
        setMappings({});
    }, []);

    const buildFormData = useCallback(() => {
        const fd = new FormData();
        if (file) fd.append('file', file);
        fd.append('source', source);
        fd.append('locale', locale);
        fd.append('mappings', JSON.stringify(mappings));
        fd.append('skipDuplicates', String(skipDuplicates));
        return fd;
    }, [file, source, locale, mappings, skipDuplicates]);

    const runPreview = useCallback(async () => {
        if (!file) return;
        setPreviewing(true);
        setError(null);
        try {
            const res = await fetch('/api/import-export/settlements/preview', {
                method: 'POST',
                body: buildFormData(),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Preview failed');
            setPreview(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Preview failed');
        } finally {
            setPreviewing(false);
        }
    }, [file, buildFormData]);

    const handleImport = useCallback(async () => {
        if (!file) return;
        setImporting(true);
        setError(null);
        try {
            const res = await fetch('/api/import-export/settlements/commit', {
                method: 'POST',
                body: buildFormData(),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Import failed');
            setResult(data);
            setPreview(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Import failed');
        } finally {
            setImporting(false);
        }
    }, [file, buildFormData]);

    const handleReset = useCallback(() => {
        setFile(null);
        setLocale('us');
        setMappings({});
        setSkipDuplicates(true);
        setPreview(null);
        setResult(null);
        setError(null);
        if (inputRef.current) inputRef.current.value = '';
    }, []);

    const roleValue = (r: RoleResolution) => mappings[r.role] ?? (r.targetGuid ?? 'new');
    const sourceInfo = SOURCES.find((s) => s.value === source)!;

    return (
        <div className="space-y-8">
            <header>
                <h1 className="text-3xl font-bold text-foreground">Import Payment Settlements</h1>
                <p className="text-foreground-muted mt-1">
                    Turn processor payout exports into correct gross / fee / net accounting in the
                    current book — sales credit income, fees hit an expense account, and payouts move
                    the clearing balance to your bank.{' '}
                    <Link href="/import-export" className="text-primary hover:text-primary-hover">
                        Back to Import / Export
                    </Link>
                </p>
            </header>

            {/* Step 1: source + upload */}
            {!result && (
                <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-6">
                    <div>
                        <h2 className="text-xl font-semibold text-foreground">Payout export</h2>
                        <p className="text-sm text-foreground-secondary mt-2">{sourceInfo.hint}</p>
                    </div>

                    <div>
                        <div className="text-sm text-foreground-secondary mb-2">Processor</div>
                        <div className="flex flex-wrap gap-2">
                            {SOURCES.map((s) => (
                                <button
                                    key={s.value}
                                    type="button"
                                    onClick={() => handleSource(s.value)}
                                    className={`px-4 py-1.5 text-sm rounded-lg border transition-colors ${
                                        source === s.value
                                            ? 'border-primary bg-primary/10 text-primary'
                                            : 'border-border text-foreground-secondary hover:text-foreground hover:border-foreground-secondary'
                                    }`}
                                >
                                    {s.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div
                        onDrop={(e) => {
                            e.preventDefault();
                            setDragOver(false);
                            const f = e.dataTransfer.files?.[0];
                            if (f) handleFile(f);
                        }}
                        onDragOver={(e) => {
                            e.preventDefault();
                            setDragOver(true);
                        }}
                        onDragLeave={(e) => {
                            e.preventDefault();
                            setDragOver(false);
                        }}
                        onClick={() => inputRef.current?.click()}
                        className={`relative border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all
                            ${dragOver
                                ? 'border-primary bg-primary/10'
                                : 'border-border hover:border-foreground-secondary hover:bg-surface/50'
                            }`}
                    >
                        <input
                            ref={inputRef}
                            type="file"
                            accept=".csv,.txt"
                            onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) handleFile(f);
                            }}
                            className="hidden"
                        />
                        <p className="text-foreground-secondary text-sm">
                            {file ? (
                                <span className="text-foreground font-medium">{file.name}</span>
                            ) : (
                                `Drop the ${sourceInfo.label} CSV here or click to browse`
                            )}
                        </p>
                    </div>

                    <div>
                        <label className="block text-sm text-foreground-secondary mb-1" htmlFor="settlement-locale">
                            Number &amp; date format
                        </label>
                        <select
                            id="settlement-locale"
                            value={locale}
                            onChange={(e) => setLocale(e.target.value === 'eu' ? 'eu' : 'us')}
                            className="bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                        >
                            <option value="us">US — 1,234.56 · MM/DD/YYYY</option>
                            <option value="eu">European — 1.234,56 · DD/MM/YYYY</option>
                        </select>
                    </div>

                    <div className="flex gap-3">
                        <button
                            onClick={() => void runPreview()}
                            disabled={previewing || !file}
                            className="flex items-center gap-2 px-5 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 text-primary-foreground rounded-xl transition-colors"
                        >
                            {previewing ? (
                                <>
                                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    Analyzing...
                                </>
                            ) : (
                                'Preview Import'
                            )}
                        </button>
                        {file && (
                            <button
                                onClick={handleReset}
                                className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                            >
                                Clear
                            </button>
                        )}
                    </div>

                    {error && !preview && (
                        <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-4 text-sm text-rose-400">
                            {error}
                        </div>
                    )}
                </section>
            )}

            {/* Step 2: mapping + preview */}
            {preview && !result && (
                <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-6">
                    <h2 className="text-xl font-semibold text-foreground">Preview</h2>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                        <div className="bg-surface/50 border border-border rounded-lg p-3">
                            <div className="text-foreground-muted text-xs">Transactions</div>
                            <div className="text-foreground font-mono text-lg">{preview.transactionCount}</div>
                            <div className="text-foreground-muted text-[11px]">
                                {(Object.entries(preview.kindCounts) as Array<[SettlementKind, number]>)
                                    .filter(([, n]) => n > 0)
                                    .map(([k, n]) => `${n} ${KIND_LABELS[k].toLowerCase()}`)
                                    .join(', ') || '—'}
                            </div>
                        </div>
                        <div className="bg-surface/50 border border-border rounded-lg p-3">
                            <div className="text-foreground-muted text-xs">Date range</div>
                            <div className="text-foreground font-mono text-sm mt-1">
                                {preview.dateRange
                                    ? `${preview.dateRange.start} → ${preview.dateRange.end}`
                                    : '—'}
                            </div>
                        </div>
                        <div className="bg-surface/50 border border-border rounded-lg p-3">
                            <div className="text-foreground-muted text-xs">Duplicates</div>
                            <div className={`font-mono text-lg ${preview.duplicateCount > 0 ? 'text-warning' : 'text-foreground'}`}>
                                {preview.duplicateCount}
                            </div>
                            {preview.lockedCount > 0 && (
                                <div className="text-foreground-muted text-[11px]">
                                    +{preview.lockedCount} period-locked
                                </div>
                            )}
                        </div>
                        <div className="bg-surface/50 border border-border rounded-lg p-3">
                            <div className="text-foreground-muted text-xs">Errors (excluded)</div>
                            <div className={`font-mono text-lg ${preview.errorCount > 0 ? 'text-negative' : 'text-foreground'}`}>
                                {preview.errorCount}
                            </div>
                        </div>
                    </div>

                    {/* Totals */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                        <div className="bg-surface/50 border border-border rounded-lg p-3">
                            <div className="text-foreground-muted text-xs">Gross sales</div>
                            <div className="text-foreground font-mono">{fmtAmount(preview.totals.gross)}</div>
                        </div>
                        <div className="bg-surface/50 border border-border rounded-lg p-3">
                            <div className="text-foreground-muted text-xs">Processing fees</div>
                            <div className="text-foreground font-mono">{fmtAmount(preview.totals.fees)}</div>
                        </div>
                        <div className="bg-surface/50 border border-border rounded-lg p-3">
                            <div className="text-foreground-muted text-xs">Payouts to bank</div>
                            <div className="text-foreground font-mono">{fmtAmount(preview.payoutTotal)}</div>
                        </div>
                        <div className="bg-surface/50 border border-border rounded-lg p-3">
                            <div className="text-foreground-muted text-xs">Clearing balance change</div>
                            <div
                                className={`font-mono ${Math.abs(preview.clearingProjection) < 0.005 ? 'text-positive' : 'text-foreground'}`}
                                title="Net change to the clearing account from this import. Near zero means payouts fully sweep the settled sales."
                            >
                                {fmtAmount(preview.clearingProjection)}
                            </div>
                        </div>
                    </div>

                    {/* Account mapping */}
                    <div className="space-y-2">
                        <h3 className="text-sm font-semibold text-foreground">
                            Target accounts
                            <span className="ml-2 text-xs font-normal text-foreground-muted">
                                where sales, fees, and payouts post in this book
                            </span>
                        </h3>
                        <div className="overflow-x-auto border border-border rounded-lg">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-xs text-foreground-muted uppercase tracking-wider bg-surface/50">
                                        <th className="text-left px-3 py-2 font-medium">Role</th>
                                        <th className="text-left px-3 py-2 font-medium">Account</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {preview.accounts
                                        .filter((r) => r.used)
                                        .map((r) => (
                                            <tr key={r.role} className="border-t border-border">
                                                <td className="px-3 py-1.5 align-top">
                                                    <div className="text-foreground">{ROLE_LABELS[r.role].title}</div>
                                                    <div className="text-[11px] text-foreground-muted max-w-[20rem]">
                                                        {ROLE_LABELS[r.role].help}
                                                    </div>
                                                </td>
                                                <td className="px-3 py-1.5">
                                                    <select
                                                        value={roleValue(r)}
                                                        onChange={(e) =>
                                                            setMappings((prev) => ({ ...prev, [r.role]: e.target.value }))
                                                        }
                                                        className="w-full max-w-md bg-input-bg border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary/50"
                                                    >
                                                        <option value="new">
                                                            ＋ Create {r.isNew ? r.path : `new account`}
                                                        </option>
                                                        {preview.accountOptions[r.role].map((o) => (
                                                            <option key={o.guid} value={o.guid}>
                                                                {o.path} ({o.type})
                                                            </option>
                                                        ))}
                                                    </select>
                                                </td>
                                            </tr>
                                        ))}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <label className="flex items-start gap-2 text-sm text-foreground-secondary cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={skipDuplicates}
                            onChange={(e) => setSkipDuplicates(e.target.checked)}
                            className="mt-0.5 accent-primary"
                        />
                        <span>
                            Skip duplicates — rows whose reference id was already imported (matching{' '}
                            <span className="font-mono text-xs">{preview.source}:&lt;reference&gt;</span> stamp)
                            are not imported again.
                        </span>
                    </label>

                    {/* Sample transactions */}
                    {preview.sampleTransactions.length > 0 && (
                        <div className="space-y-2">
                            <h3 className="text-sm font-semibold text-foreground">
                                Rows (first {preview.sampleTransactions.length} of {preview.transactionCount})
                            </h3>
                            <div className="overflow-x-auto border border-border rounded-lg">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="text-xs text-foreground-muted uppercase tracking-wider bg-surface/50">
                                            <th className="text-left px-3 py-2 font-medium">Date</th>
                                            <th className="text-left px-3 py-2 font-medium">Kind</th>
                                            <th className="text-left px-3 py-2 font-medium">Description</th>
                                            <th className="text-right px-3 py-2 font-medium">Gross</th>
                                            <th className="text-right px-3 py-2 font-medium">Fee</th>
                                            <th className="text-right px-3 py-2 font-medium">Net</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {preview.sampleTransactions.map((t, i) => (
                                            <tr key={i} className="border-t border-border">
                                                <td className="px-3 py-1.5 font-mono text-foreground-secondary whitespace-nowrap">{t.date}</td>
                                                <td className="px-3 py-1.5 text-foreground-secondary whitespace-nowrap">{KIND_LABELS[t.kind]}</td>
                                                <td className="px-3 py-1.5 text-foreground max-w-[16rem] truncate">{t.description}</td>
                                                <td className="px-3 py-1.5 font-mono text-right text-foreground-secondary whitespace-nowrap">
                                                    {t.kind === 'payout' ? '—' : fmtAmount(t.gross)}
                                                </td>
                                                <td className="px-3 py-1.5 font-mono text-right text-foreground-secondary whitespace-nowrap">
                                                    {t.kind === 'payout' ? '—' : fmtAmount(t.fee)}
                                                </td>
                                                <td
                                                    className={`px-3 py-1.5 font-mono text-right whitespace-nowrap ${t.net > 0 ? 'text-positive' : t.net < 0 ? 'text-negative' : 'text-foreground-secondary'}`}
                                                >
                                                    {fmtAmount(t.net)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    {/* Skipped duplicates */}
                    {preview.skippedDuplicates.length > 0 && (
                        <div className="bg-surface/50 border border-border rounded-lg p-4">
                            <h4 className="text-foreground-secondary font-medium text-sm mb-2">
                                Duplicates found ({preview.duplicateCount})
                            </h4>
                            <ul className="text-xs text-foreground-muted font-mono space-y-1 max-h-40 overflow-y-auto">
                                {preview.skippedDuplicates.map((d, i) => (
                                    <li key={i}>
                                        Row {d.row}: {d.date} {fmtAmount(d.net)} — {d.description} ({d.reference})
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {/* Errors */}
                    {preview.errors.length > 0 && (
                        <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-4">
                            <h4 className="text-rose-400 font-medium text-sm mb-2">
                                Excluded rows ({preview.errorCount})
                            </h4>
                            <ul className="text-xs text-rose-300/80 font-mono space-y-1 max-h-40 overflow-y-auto">
                                {preview.errors.map((e, i) => (
                                    <li key={i}>
                                        Row {e.row}: {e.message}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {/* Warnings */}
                    {preview.warnings.length > 0 && (
                        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
                            <h4 className="text-amber-400 font-medium text-sm mb-2">
                                Warnings ({preview.warnings.length})
                            </h4>
                            <ul className="text-xs text-amber-300/80 space-y-1 max-h-40 overflow-y-auto">
                                {preview.warnings.map((w, i) => (
                                    <li key={i}>{w}</li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {error && (
                        <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-4 text-sm text-rose-400">
                            {error}
                        </div>
                    )}

                    <div className="flex gap-3">
                        <button
                            onClick={() => void handleImport()}
                            disabled={importing || preview.transactionCount === 0}
                            className="flex items-center gap-2 px-5 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 text-primary-foreground rounded-xl transition-colors"
                        >
                            {importing ? (
                                <>
                                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    Importing...
                                </>
                            ) : (
                                `Import ${preview.transactionCount} Transaction${preview.transactionCount === 1 ? '' : 's'}`
                            )}
                        </button>
                        <button
                            onClick={() => void runPreview()}
                            disabled={previewing || importing}
                            className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                            title="Re-run the preview with the current mappings"
                        >
                            Refresh Preview
                        </button>
                        <button
                            onClick={() => setPreview(null)}
                            disabled={importing}
                            className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                </section>
            )}

            {/* Step 3: result */}
            {result && (
                <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-4">
                    <div className="bg-primary/10 border border-primary/30 rounded-lg p-4">
                        <h3 className="text-primary font-semibold mb-2">Import Successful</h3>
                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
                            <div>
                                <span className="text-foreground-muted">Transactions: </span>
                                <span className="text-foreground font-mono">{result.transactionsCreated}</span>
                            </div>
                            <div>
                                <span className="text-foreground-muted">Splits: </span>
                                <span className="text-foreground font-mono">{result.splitsCreated}</span>
                            </div>
                            <div>
                                <span className="text-foreground-muted">Accounts created: </span>
                                <span className="text-foreground font-mono">{result.accountsCreated}</span>
                            </div>
                            <div>
                                <span className="text-foreground-muted">Duplicates skipped: </span>
                                <span className="text-foreground font-mono">{result.duplicatesSkipped}</span>
                            </div>
                            <div>
                                <span className="text-foreground-muted">Locked skipped: </span>
                                <span className="text-foreground font-mono">{result.lockedSkipped}</span>
                            </div>
                        </div>
                        <p className="text-sm text-foreground-secondary mt-3">
                            Sales, fees, and payouts posted through{' '}
                            <span className="font-mono text-xs">{result.clearingAccountPath}</span>.
                        </p>
                    </div>

                    {result.warnings.length > 0 && (
                        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
                            <h4 className="text-amber-400 font-medium text-sm mb-2">
                                Warnings ({result.warnings.length})
                            </h4>
                            <ul className="text-xs text-amber-300/80 space-y-1 max-h-40 overflow-y-auto">
                                {result.warnings.map((w, i) => (
                                    <li key={i}>{w}</li>
                                ))}
                            </ul>
                        </div>
                    )}

                    <div className="flex gap-3">
                        <button
                            onClick={handleReset}
                            className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                        >
                            Import Another File
                        </button>
                        <Link
                            href="/accounts"
                            className="px-4 py-2 text-sm text-primary hover:text-primary-hover transition-colors"
                        >
                            View Accounts
                        </Link>
                    </div>
                </section>
            )}
        </div>
    );
}
