'use client';

/**
 * Shared import wizard for the personal-finance CSV importers
 * (Mint / YNAB / Monarch). Steps: upload → mapping/preview → commit → result.
 * Parameterized per source; the pages under /import-export/{source} are thin
 * wrappers. Follows the QuickBooks import page's visual patterns.
 */

import { useState, useRef, useCallback } from 'react';
import Link from 'next/link';

/* ------------------------------------------------------------------ */
/* Types (mirror PersonalPreview / PersonalCommitResult)                */
/* ------------------------------------------------------------------ */

interface PreviewAccountRow {
    name: string;
    records: number;
    targetGuid: string | null;
    targetPath: string;
    accountType: string;
    isNew: boolean;
    mapped: boolean;
}

interface PreviewCategoryRow {
    name: string;
    records: number;
    total: number;
    targetGuid: string | null;
    targetPath: string;
    accountType: string;
    isNew: boolean;
    mapped: boolean;
}

interface AccountOption {
    guid: string;
    path: string;
    type: string;
}

interface PreviewData {
    source: string;
    transactionCount: number;
    rowsRead: number;
    errorCount: number;
    duplicateCount: number;
    lockedCount: number;
    lockDate: string | null;
    ambiguousDateRows: number;
    dateRange: { start: string; end: string } | null;
    accounts: PreviewAccountRow[];
    categories: PreviewCategoryRow[];
    errors: Array<{ row: number; message: string }>;
    warnings: string[];
    sourceAccountOptions: AccountOption[];
    categoryAccountOptions: AccountOption[];
    sampleTransactions: Array<{
        date: string;
        description: string;
        amount: number;
        account: string;
        category: string;
    }>;
    skippedDuplicates: Array<{
        row: number;
        date: string;
        amount: number;
        description: string;
        account: string;
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
}

export interface PersonalImportConfig {
    source: 'mint' | 'ynab' | 'monarch';
    title: string;
    /** Intro sentence under the page title */
    blurb: string;
    /** How to produce the export, shown above the drop zone */
    exportHint: React.ReactNode;
    dropHint: string;
}

const fmtAmount = (n: number) =>
    n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ------------------------------------------------------------------ */
/* Wizard                                                               */
/* ------------------------------------------------------------------ */

export default function PersonalImportWizard({ config }: { config: PersonalImportConfig }) {
    const apiBase = `/api/import-export/${config.source}`;

    const [file, setFile] = useState<File | null>(null);
    const [dragOver, setDragOver] = useState(false);
    const [locale, setLocale] = useState<'us' | 'eu'>('us');
    const [accountMappings, setAccountMappings] = useState<Record<string, string>>({});
    const [categoryMappings, setCategoryMappings] = useState<Record<string, string>>({});
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
        setAccountMappings({});
        setCategoryMappings({});
    }, []);

    const buildFormData = useCallback(() => {
        const fd = new FormData();
        if (file) fd.append('file', file);
        fd.append('locale', locale);
        fd.append('accountMappings', JSON.stringify(accountMappings));
        fd.append('categoryMappings', JSON.stringify(categoryMappings));
        fd.append('skipDuplicates', String(skipDuplicates));
        return fd;
    }, [file, locale, accountMappings, categoryMappings, skipDuplicates]);

    const runPreview = useCallback(async () => {
        if (!file) return;
        setPreviewing(true);
        setError(null);
        try {
            const res = await fetch(`${apiBase}/preview`, { method: 'POST', body: buildFormData() });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Preview failed');
            setPreview(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Preview failed');
        } finally {
            setPreviewing(false);
        }
    }, [file, apiBase, buildFormData]);

    const handleImport = useCallback(async () => {
        if (!file) return;
        setImporting(true);
        setError(null);
        try {
            const res = await fetch(`${apiBase}/commit`, { method: 'POST', body: buildFormData() });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Import failed');
            setResult(data);
            setPreview(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Import failed');
        } finally {
            setImporting(false);
        }
    }, [file, apiBase, buildFormData]);

    const handleReset = useCallback(() => {
        setFile(null);
        setLocale('us');
        setAccountMappings({});
        setCategoryMappings({});
        setSkipDuplicates(true);
        setPreview(null);
        setResult(null);
        setError(null);
        if (inputRef.current) inputRef.current.value = '';
    }, []);

    /** Current select value for a source account row. */
    const accountValue = (a: PreviewAccountRow) =>
        accountMappings[a.name] ?? (a.targetGuid ?? `new:${a.accountType === 'CREDIT' ? 'CREDIT' : 'BANK'}`);

    const categoryValue = (c: PreviewCategoryRow) =>
        categoryMappings[c.name] ?? (c.targetGuid ?? 'new');

    return (
        <div className="space-y-8">
            <header>
                <h1 className="text-3xl font-bold text-foreground">{config.title}</h1>
                <p className="text-foreground-muted mt-1">
                    {config.blurb}{' '}
                    <Link href="/import-export" className="text-primary hover:text-primary-hover">
                        Back to Import / Export
                    </Link>
                </p>
            </header>

            {/* Step 1: upload */}
            {!result && (
                <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-6">
                    <div>
                        <h2 className="text-xl font-semibold text-foreground">Transactions CSV</h2>
                        <div className="text-sm text-foreground-secondary mt-2">{config.exportHint}</div>
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
                                config.dropHint
                            )}
                        </p>
                    </div>

                    <div>
                        <label
                            className="block text-sm text-foreground-secondary mb-1"
                            htmlFor={`${config.source}-locale`}
                        >
                            Number &amp; date format
                        </label>
                        <select
                            id={`${config.source}-locale`}
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

                    {/* Source account mapping */}
                    <div className="space-y-2">
                        <h3 className="text-sm font-semibold text-foreground">
                            Accounts ({preview.accounts.length})
                            <span className="ml-2 text-xs font-normal text-foreground-muted">
                                map each source account to a bank/credit account in this book
                            </span>
                        </h3>
                        <div className="overflow-x-auto border border-border rounded-lg">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-xs text-foreground-muted uppercase tracking-wider bg-surface/50">
                                        <th className="text-left px-3 py-2 font-medium">Source account</th>
                                        <th className="text-right px-3 py-2 font-medium">Rows</th>
                                        <th className="text-left px-3 py-2 font-medium">Import into</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {preview.accounts.map((a) => (
                                        <tr key={a.name} className="border-t border-border">
                                            <td className="px-3 py-1.5 text-foreground max-w-[18rem] truncate">{a.name}</td>
                                            <td className="px-3 py-1.5 font-mono text-right text-foreground-secondary">{a.records}</td>
                                            <td className="px-3 py-1.5">
                                                <select
                                                    value={accountValue(a)}
                                                    onChange={(e) =>
                                                        setAccountMappings((prev) => ({ ...prev, [a.name]: e.target.value }))
                                                    }
                                                    className="w-full max-w-md bg-input-bg border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary/50"
                                                >
                                                    <option value="new:BANK">＋ Create new bank account &quot;{a.name}&quot;</option>
                                                    <option value="new:CREDIT">＋ Create new credit card account &quot;{a.name}&quot;</option>
                                                    {preview.sourceAccountOptions.map((o) => (
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

                    {/* Category mapping */}
                    <div className="space-y-2">
                        <h3 className="text-sm font-semibold text-foreground">
                            Categories ({preview.categories.length})
                            <span className="ml-2 text-xs font-normal text-foreground-muted">
                                unmatched categories are created under Expenses:Imported (or Income:Imported)
                            </span>
                        </h3>
                        <div className="overflow-x-auto border border-border rounded-lg max-h-96 overflow-y-auto">
                            <table className="w-full text-sm">
                                <thead className="sticky top-0 bg-surface">
                                    <tr className="text-xs text-foreground-muted uppercase tracking-wider">
                                        <th className="text-left px-3 py-2 font-medium">Category</th>
                                        <th className="text-right px-3 py-2 font-medium">Rows</th>
                                        <th className="text-right px-3 py-2 font-medium">Net</th>
                                        <th className="text-left px-3 py-2 font-medium">Import into</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {preview.categories.map((c) => (
                                        <tr key={c.name} className="border-t border-border">
                                            <td className="px-3 py-1.5 text-foreground max-w-[16rem] truncate">{c.name}</td>
                                            <td className="px-3 py-1.5 font-mono text-right text-foreground-secondary">{c.records}</td>
                                            <td
                                                className={`px-3 py-1.5 font-mono text-right whitespace-nowrap ${c.total > 0 ? 'text-positive' : c.total < 0 ? 'text-negative' : 'text-foreground-secondary'}`}
                                            >
                                                {fmtAmount(c.total)}
                                            </td>
                                            <td className="px-3 py-1.5">
                                                <select
                                                    value={categoryValue(c)}
                                                    onChange={(e) =>
                                                        setCategoryMappings((prev) => ({ ...prev, [c.name]: e.target.value }))
                                                    }
                                                    className="w-full max-w-md bg-input-bg border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary/50"
                                                >
                                                    <option value="new">
                                                        ＋ Create {c.isNew ? c.targetPath : `Expenses:Imported:${c.name}`}
                                                    </option>
                                                    {preview.categoryAccountOptions.map((o) => (
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
                            Skip duplicates — rows matching an existing transaction in the target account
                            (same date, amount, and similar description) are not imported.
                        </span>
                    </label>

                    {/* Sample transactions */}
                    {preview.sampleTransactions.length > 0 && (
                        <div className="space-y-2">
                            <h3 className="text-sm font-semibold text-foreground">
                                Transactions (first {preview.sampleTransactions.length} of {preview.transactionCount})
                            </h3>
                            <div className="overflow-x-auto border border-border rounded-lg">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="text-xs text-foreground-muted uppercase tracking-wider bg-surface/50">
                                            <th className="text-left px-3 py-2 font-medium">Date</th>
                                            <th className="text-left px-3 py-2 font-medium">Description</th>
                                            <th className="text-left px-3 py-2 font-medium">Account</th>
                                            <th className="text-left px-3 py-2 font-medium">Category</th>
                                            <th className="text-right px-3 py-2 font-medium">Amount</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {preview.sampleTransactions.map((t, i) => (
                                            <tr key={i} className="border-t border-border">
                                                <td className="px-3 py-1.5 font-mono text-foreground-secondary whitespace-nowrap">{t.date}</td>
                                                <td className="px-3 py-1.5 text-foreground max-w-[18rem] truncate">{t.description}</td>
                                                <td className="px-3 py-1.5 text-foreground-secondary max-w-[12rem] truncate">{t.account}</td>
                                                <td className="px-3 py-1.5 text-foreground-secondary max-w-[12rem] truncate">{t.category}</td>
                                                <td
                                                    className={`px-3 py-1.5 font-mono text-right whitespace-nowrap ${t.amount > 0 ? 'text-positive' : t.amount < 0 ? 'text-negative' : 'text-foreground-secondary'}`}
                                                >
                                                    {fmtAmount(t.amount)}
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
                                        Row {d.row}: {d.date} {fmtAmount(d.amount)} — {d.description} ({d.account})
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
                            title="Re-run the preview with the current mappings (updates duplicate detection)"
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
