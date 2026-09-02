'use client';

import { useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useBooks } from '@/contexts/BookContext';

interface PreviewAccount {
    path: string;
    gnucashType: string;
    source: 'override' | 'coa' | 'statement' | 'inferred' | 'default';
    lines: number;
    targetPath: string;
}

interface TreePreview {
    accounts: Array<{ path: string; accountType: string; placeholder: boolean; origin: 'scaffold' | 'coa' | 'journal' }>;
    fromChart: number;
    journalOnly: Array<{ path: string; placedAs: string; how: 'deleted-suffix' | 'parent' | 'type' }>;
}

interface PreviewData {
    companyName: string | null;
    transactionCount: number;
    splitCount: number;
    errorCount: number;
    dateRange: { start: string; end: string } | null;
    accounts: PreviewAccount[];
    accountsByType: Record<string, number>;
    errors: Array<{ row: number; message: string }>;
    warnings: string[];
    coaLoaded: boolean;
    coaAccountCount: number;
    coaSource?: 'chart_of_accounts' | 'statements' | null;
    duplicateWarning: string | null;
    sourceFormat: 'journal' | 'general_ledger';
    glStats: { reconstructed: number; failed: number } | null;
    sheets: Array<{ name: string; kind: string; used: boolean }> | null;
    tree: TreePreview;
    business: {
        customers: number;
        vendors: number;
        employees: number;
        invoices: number;
        creditNotes: number;
        bills: number;
        customerPayments: number;
        billPayments: number;
        paidInFull: number;
        partiallyPaid: number;
        unallocatedPayments: number;
        unallocatedAmount: number;
        skipped: number;
        skippedSamples: Array<{ type: string; name: string; date: string; reason: string }>;
    };
    sampleTransactions: Array<{ date: string; description: string; amount: number; lines: number }>;
}

interface CommitResult {
    bookGuid: string;
    accountsCreated: number;
    transactionsCreated: number;
    splitsCreated: number;
    customersCreated?: number;
    vendorsCreated?: number;
    employeesCreated?: number;
    invoicesCreated?: number;
    billsCreated?: number;
    paymentsApplied?: number;
    skippedErrors: number;
    warnings: string[];
}

const ENTITY_OPTIONS: Array<{ value: string; label: string }> = [
    { value: 'c_corp', label: 'C Corporation' },
    { value: 's_corp', label: 'S Corporation' },
    { value: 'llc_single', label: 'LLC (single member)' },
    { value: 'llc_partnership', label: 'LLC / Partnership' },
    { value: 'sole_prop', label: 'Sole Proprietorship' },
    { value: 'nonprofit_501c3', label: 'Nonprofit 501(c)(3)' },
    { value: 'household', label: 'Household' },
];

const ACCOUNT_TYPE_OPTIONS = [
    'BANK',
    'CASH',
    'ASSET',
    'RECEIVABLE',
    'PAYABLE',
    'CREDIT',
    'LIABILITY',
    'EQUITY',
    'INCOME',
    'EXPENSE',
];

const SOURCE_LABEL: Record<PreviewAccount['source'], string> = {
    override: 'manual',
    coa: 'chart of accounts',
    statement: 'balance sheet / P&L',
    inferred: 'inferred from name',
    default: 'default (review)',
};

const SHEET_KIND_LABEL: Record<string, string> = {
    journal: 'Journal',
    general_ledger: 'General Ledger',
    chart_of_accounts: 'Chart of Accounts',
    balance_sheet: 'Balance Sheet',
    profit_and_loss: 'Profit and Loss',
    customers: 'Customers',
    vendors: 'Vendors',
    employees: 'Employees',
    unknown: 'not used',
};

const fmtAmount = (n: number) =>
    n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function FileDrop({
    label,
    hint,
    file,
    onFile,
    accept,
}: {
    label: string;
    hint: string;
    file: File | null;
    onFile: (f: File) => void;
    accept: string;
}) {
    const [dragOver, setDragOver] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    return (
        <div>
            <div className="text-sm font-medium text-foreground mb-1">{label}</div>
            <div
                onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) onFile(f);
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
                className={`relative border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition-all
                    ${dragOver
                        ? 'border-primary bg-primary/10'
                        : 'border-border hover:border-foreground-secondary hover:bg-surface/50'
                    }`}
            >
                <input
                    ref={inputRef}
                    type="file"
                    accept={accept}
                    onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) onFile(f);
                    }}
                    className="hidden"
                />
                <p className="text-foreground-secondary text-sm">
                    {file ? (
                        <span className="text-foreground font-medium">{file.name}</span>
                    ) : (
                        hint
                    )}
                </p>
            </div>
        </div>
    );
}

export default function QuickBooksImportPage() {
    const { refreshBooks } = useBooks();

    const [archiveFile, setArchiveFile] = useState<File | null>(null);
    const [journalFile, setJournalFile] = useState<File | null>(null);
    const [coaFile, setCoaFile] = useState<File | null>(null);
    const [csvMode, setCsvMode] = useState(false);
    const [locale, setLocale] = useState<'us' | 'eu'>('us');
    const [bookName, setBookName] = useState('');
    const [bookNameTouched, setBookNameTouched] = useState(false);
    const [entityType, setEntityType] = useState('c_corp');
    const [typeOverrides, setTypeOverrides] = useState<Record<string, string>>({});

    const [preview, setPreview] = useState<PreviewData | null>(null);
    const [previewing, setPreviewing] = useState(false);
    const [importing, setImporting] = useState(false);
    const [result, setResult] = useState<CommitResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    // The ZIP and the Chart of Accounts CSV go in together; only the Journal
    // CSV is an alternative to the ZIP.
    const handleArchiveFile = useCallback((f: File) => {
        setArchiveFile(f);
        setJournalFile(null);
        setPreview(null);
        setResult(null);
        setError(null);
        setTypeOverrides({});
    }, []);

    const handleJournalFile = useCallback((f: File) => {
        setJournalFile(f);
        setArchiveFile(null);
        setPreview(null);
        setResult(null);
        setError(null);
        setTypeOverrides({});
    }, []);

    const handleCoaFile = useCallback((f: File) => {
        setCoaFile(f);
        setPreview(null);
        setResult(null);
        setError(null);
    }, []);

    const buildFormData = useCallback(
        (extra: Record<string, string> = {}) => {
            const fd = new FormData();
            if (archiveFile) fd.append('archive', archiveFile);
            if (journalFile) fd.append('journal', journalFile);
            if (coaFile) fd.append('coa', coaFile);
            if (bookName.trim()) fd.append('bookName', bookName.trim());
            fd.append('typeOverrides', JSON.stringify(typeOverrides));
            fd.append('locale', locale);
            for (const [k, v] of Object.entries(extra)) fd.append(k, v);
            return fd;
        },
        [archiveFile, journalFile, coaFile, bookName, typeOverrides, locale]
    );

    const hasSource = Boolean(archiveFile || journalFile);

    const runPreview = useCallback(async () => {
        if (!hasSource) return;
        setPreviewing(true);
        setError(null);
        try {
            const res = await fetch('/api/import-export/quickbooks/preview', {
                method: 'POST',
                body: buildFormData(),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Preview failed');
            setPreview(data);
            if (!bookNameTouched && !bookName.trim() && data.companyName) {
                setBookName(data.companyName);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Preview failed');
        } finally {
            setPreviewing(false);
        }
    }, [hasSource, buildFormData, bookName, bookNameTouched]);

    const handleImport = useCallback(async () => {
        if (!hasSource || !bookName.trim()) return;
        setImporting(true);
        setError(null);
        try {
            const res = await fetch('/api/import-export/quickbooks/commit', {
                method: 'POST',
                body: buildFormData({ entityType, currency: 'USD' }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Import failed');
            setResult(data);
            setPreview(null);
            await refreshBooks();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Import failed');
        } finally {
            setImporting(false);
        }
    }, [hasSource, bookName, entityType, buildFormData, refreshBooks]);

    const handleOverride = useCallback((path: string, type: string) => {
        setTypeOverrides((prev) => ({ ...prev, [path]: type }));
    }, []);

    const handleReset = useCallback(() => {
        setArchiveFile(null);
        setJournalFile(null);
        setCoaFile(null);
        setCsvMode(false);
        setLocale('us');
        setBookName('');
        setBookNameTouched(false);
        setEntityType('c_corp');
        setTypeOverrides({});
        setPreview(null);
        setResult(null);
        setError(null);
    }, []);

    const effectiveType = (a: PreviewAccount) => typeOverrides[a.path] ?? a.gnucashType;

    return (
        <div className="space-y-8">
            <header>
                <h1 className="text-3xl font-bold text-foreground">Import QuickBooks Online</h1>
                <p className="text-foreground-muted mt-1">
                    Rebuild a QuickBooks Online company as a new book from its report exports — no
                    Intuit connection required.{' '}
                    <Link href="/import-export" className="text-primary hover:text-primary-hover">
                        Back to Import / Export
                    </Link>
                </p>
            </header>

            {/* Step 1: upload */}
            {!result && (
                <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-lg p-6 space-y-6">
                    <div>
                        <h2 className="text-xl font-semibold text-foreground">Export files</h2>
                        <div className="text-sm text-foreground-secondary mt-2 space-y-2">
                            <p>
                                In QuickBooks Online go to{' '}
                                <span className="font-mono text-xs">Settings gear → Tools → Export data</span>,
                                select all reports and lists, download the ZIP, and drop it below.
                                Transactions are rebuilt from the Journal sheet when present, otherwise
                                from the General Ledger. Account types come from the Chart of Accounts
                                when the export has one, otherwise from the Balance Sheet and Profit and
                                Loss reports (every account sits under its QuickBooks type section there).
                            </p>
                        </div>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                        <FileDrop
                            label="QuickBooks Export Data ZIP (Settings gear → Tools → Export data)"
                            hint="Drop the Export data ZIP (or a single .xlsx report) here or click to browse"
                            file={archiveFile}
                            onFile={handleArchiveFile}
                            accept=".zip,.xlsx"
                        />
                        <FileDrop
                            label="Chart of Accounts CSV (recommended)"
                            hint="Settings gear → Chart of accounts → Run report → Export to CSV"
                            file={coaFile}
                            onFile={handleCoaFile}
                            accept=".csv,.txt,.xlsx"
                        />
                    </div>
                    <p className="text-xs text-foreground-muted">
                        The Export data ZIP does not include the Chart of Accounts. With the CSV, the book is built
                        from the chart itself: GnuCash top-level accounts (Assets, Liabilities, Equity, Income,
                        Expenses), a group per QuickBooks account type beneath them, and every account — used or
                        not — nested under its group with the type taken from the group.
                    </p>

                    <div>
                        <button
                            type="button"
                            onClick={() => setCsvMode((v) => !v)}
                            className="text-sm text-primary hover:text-primary-hover transition-colors"
                        >
                            {csvMode ? '▾' : '▸'} or upload the Journal report as CSV instead of the ZIP
                        </button>
                        {csvMode && (
                            <div className="mt-4 space-y-4">
                                <p className="text-sm text-foreground-secondary">
                                    <span className="text-foreground font-medium">Journal report:</span>{' '}
                                    Go to <span className="font-mono text-xs">Reports → Journal</span>,
                                    set the report period to the full date range you want to migrate (e.g. All Dates),
                                    run the report, then use the export icon → <span className="font-mono text-xs">Export to CSV</span>.
                                    Pair it with the Chart of Accounts CSV above.
                                </p>
                                <FileDrop
                                    label="Journal report CSV"
                                    hint="Drop the Journal export here or click to browse"
                                    file={journalFile}
                                    onFile={handleJournalFile}
                                    accept=".csv,.txt,.xlsx"
                                />
                            </div>
                        )}
                    </div>

                    <div>
                        <label className="block text-sm text-foreground-secondary mb-1" htmlFor="qbo-locale">
                            Number &amp; date format
                        </label>
                        <select
                            id="qbo-locale"
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
                            disabled={previewing || !hasSource}
                            className="flex items-center gap-2 px-5 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 text-primary-foreground rounded-lg transition-colors"
                        >
                            {previewing ? (
                                <>
                                    <div className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                                    Analyzing...
                                </>
                            ) : (
                                'Preview Import'
                            )}
                        </button>
                        {(archiveFile || journalFile || coaFile) && (
                            <button
                                onClick={handleReset}
                                className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                            >
                                Clear
                            </button>
                        )}
                    </div>

                    {error && (
                        <div className="bg-error/10 border border-error/30 rounded-lg p-4 text-sm text-error">
                            {error}
                        </div>
                    )}
                </section>
            )}

            {/* Step 2: preview */}
            {preview && !result && (
                <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-lg p-6 space-y-6">
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
                            <div className="text-foreground-muted text-xs">Accounts</div>
                            <div className="text-foreground font-mono text-lg">{preview.accounts.length}</div>
                            <div className="text-foreground-muted text-[11px]">
                                {Object.entries(preview.accountsByType)
                                    .sort((a, b) => b[1] - a[1])
                                    .map(([t, n]) => `${n} ${t}`)
                                    .join(', ')}
                            </div>
                        </div>
                        <div className="bg-surface/50 border border-border rounded-lg p-3">
                            <div className="text-foreground-muted text-xs">Errors (excluded)</div>
                            <div className={`font-mono text-lg ${preview.errorCount > 0 ? 'text-negative' : 'text-foreground'}`}>
                                {preview.errorCount}
                            </div>
                        </div>
                    </div>

                    {/* Source format + sheets */}
                    <div className="text-sm text-foreground-secondary space-y-2">
                        <p>
                            <span className="text-foreground-muted text-xs uppercase tracking-wider mr-2">Source</span>
                            {preview.sourceFormat === 'journal' ? (
                                <span className="text-foreground">Journal report</span>
                            ) : (
                                <span className="text-foreground">
                                    General Ledger (transactions reconstructed)
                                    {preview.glStats && (
                                        <span className="text-foreground-muted">
                                            {' '}
                                            — {preview.glStats.reconstructed} reconstructed
                                            {preview.glStats.failed > 0 && (
                                                <span className="text-warning">, {preview.glStats.failed} failed</span>
                                            )}
                                        </span>
                                    )}
                                </span>
                            )}
                        </p>
                        {preview.sheets && preview.sheets.length > 0 && (
                            <p className="text-xs text-foreground-muted">
                                Sheets found:{' '}
                                {preview.sheets.map((s, i) => (
                                    <span key={`${s.name}-${i}`}>
                                        {i > 0 && ', '}
                                        <span className={s.used ? 'text-foreground-secondary' : ''}>
                                            {s.name} ({SHEET_KIND_LABEL[s.kind] ?? s.kind}
                                            {s.used ? ', used' : ''})
                                        </span>
                                    </span>
                                ))}
                            </p>
                        )}
                        {preview.sourceFormat === 'general_ledger' &&
                            preview.glStats &&
                            preview.glStats.failed > 0 && (
                                <div className="bg-warning/10 border border-warning/30 rounded-lg p-3 text-xs text-warning">
                                    Some transactions could not be reconstructed from the General Ledger.
                                    For a lossless import, export the Journal report instead
                                    (<span className="font-mono">Reports → Journal → Export to CSV</span>)
                                    and upload it via the CSV option.
                                </div>
                            )}
                    </div>

                    {/* Book options */}
                    <div className="flex flex-col sm:flex-row gap-4">
                        <div className="flex-1">
                            <label className="block text-sm text-foreground-secondary mb-1" htmlFor="qbo-book-name">
                                New book name
                            </label>
                            <input
                                id="qbo-book-name"
                                type="text"
                                value={bookName}
                                onChange={(e) => {
                                    setBookName(e.target.value);
                                    setBookNameTouched(true);
                                }}
                                placeholder={preview.companyName ?? 'Company name'}
                                className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
                            />
                        </div>
                        <div>
                            <label className="block text-sm text-foreground-secondary mb-1" htmlFor="qbo-entity-type">
                                Entity type
                            </label>
                            <select
                                id="qbo-entity-type"
                                value={entityType}
                                onChange={(e) => setEntityType(e.target.value)}
                                className="bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                            >
                                {ENTITY_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>
                                        {o.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {preview.duplicateWarning && (
                        <div className="bg-warning/10 border border-warning/30 rounded-lg p-4 text-sm text-warning">
                            {preview.duplicateWarning}
                        </div>
                    )}

                    {/* Account types */}
                    <div className="space-y-2">
                        <h3 className="text-sm font-semibold text-foreground">
                            Accounts ({preview.accounts.length})
                            {preview.coaLoaded ? (
                                <span className="ml-2 text-xs font-normal text-foreground-muted">
                                    typed from{' '}
                                    {preview.coaSource === 'statements'
                                        ? 'Balance Sheet + Profit and Loss'
                                        : 'Chart of Accounts'}{' '}
                                    ({preview.coaAccountCount} accounts)
                                </span>
                            ) : (
                                <span className="ml-2 text-xs font-normal text-warning">
                                    no Chart of Accounts — types inferred from names; upload the Chart of
                                    Accounts CSV for an exact structure
                                </span>
                            )}
                        </h3>
                        <div className="overflow-x-auto border border-border rounded-lg max-h-96 overflow-y-auto">
                            <table className="w-full text-sm">
                                <thead className="sticky top-0 bg-surface">
                                    <tr className="text-xs text-foreground-muted uppercase tracking-wider">
                                        <th className="text-left px-3 py-2 font-medium">QuickBooks account</th>
                                        <th className="text-left px-3 py-2 font-medium">Imports as</th>
                                        <th className="text-right px-3 py-2 font-medium">Lines</th>
                                        <th className="text-left px-3 py-2 font-medium">Source</th>
                                        <th className="text-left px-3 py-2 font-medium">Type</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {preview.accounts.map((a) => (
                                        <tr key={a.path} className="border-t border-border">
                                            <td className="px-3 py-1.5 text-foreground font-mono text-xs max-w-[18rem] truncate">
                                                {a.path}
                                            </td>
                                            <td className="px-3 py-1.5 text-foreground-secondary font-mono text-xs max-w-[22rem] truncate">
                                                {a.targetPath}
                                            </td>
                                            <td className="px-3 py-1.5 font-mono text-right text-foreground-secondary">
                                                {a.lines}
                                            </td>
                                            <td className="px-3 py-1.5 text-xs">
                                                <span
                                                    className={
                                                        typeOverrides[a.path]
                                                            ? 'text-primary'
                                                            : a.source === 'default'
                                                                ? 'text-warning'
                                                                : 'text-foreground-muted'
                                                    }
                                                >
                                                    {typeOverrides[a.path] ? 'manual' : SOURCE_LABEL[a.source]}
                                                </span>
                                            </td>
                                            <td className="px-3 py-1.5">
                                                <select
                                                    value={effectiveType(a)}
                                                    onChange={(e) => handleOverride(a.path, e.target.value)}
                                                    className="bg-input-bg border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary/50"
                                                >
                                                    {ACCOUNT_TYPE_OPTIONS.map((t) => (
                                                        <option key={t} value={t}>
                                                            {t}
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

                    {/* Account tree that will be created */}
                    {preview.tree && (
                        <details className="space-y-2">
                            <summary className="cursor-pointer text-sm font-semibold text-foreground">
                                Book structure ({preview.tree.accounts.length} accounts:{' '}
                                {preview.tree.fromChart} from the chart,{' '}
                                {preview.tree.accounts.filter((n) => n.origin === 'scaffold').length} GnuCash groups
                                {preview.tree.journalOnly.length > 0 && (
                                    <>, {preview.tree.journalOnly.length} journal-only</>
                                )}
                                )
                            </summary>
                            <div className="mt-2 border border-border rounded-lg max-h-96 overflow-y-auto p-3 font-mono text-xs">
                                {preview.tree.accounts.map((n) => {
                                    const depth = n.path.split(':').length - 1;
                                    return (
                                        <div
                                            key={n.path}
                                            className={n.placeholder ? 'text-foreground-muted' : 'text-foreground'}
                                            style={{ paddingLeft: `${depth * 1.25}rem` }}
                                        >
                                            {n.path.split(':').pop()}
                                            <span className="ml-2 text-foreground-muted">{n.accountType}</span>
                                            {n.origin === 'journal' && (
                                                <span className="ml-2 text-warning">not in chart</span>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </details>
                    )}

                    {/* Business records */}
                    {preview.business && (
                        <div className="space-y-2">
                            <h3 className="text-sm font-semibold text-foreground">Business records</h3>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                                {(
                                    [
                                        ['Customers', preview.business.customers],
                                        ['Vendors', preview.business.vendors],
                                        ['Employees', preview.business.employees],
                                        ['Invoices', preview.business.invoices],
                                        ['Credit notes', preview.business.creditNotes],
                                        ['Bills', preview.business.bills],
                                        ['Customer payments', preview.business.customerPayments],
                                        ['Bill payments', preview.business.billPayments],
                                        ['Paid in full', preview.business.paidInFull],
                                    ] as Array<[string, number]>
                                ).map(([label, n]) => (
                                    <div key={label} className="bg-surface/50 border border-border rounded-lg p-3">
                                        <div className="text-xs text-foreground-muted uppercase tracking-wider">{label}</div>
                                        <div className="text-foreground font-mono text-lg">{n.toLocaleString()}</div>
                                    </div>
                                ))}
                            </div>
                            <p className="text-xs text-foreground-muted">
                                Invoices and bills are posted against their journal transactions with an A/R–A/P lot;
                                payments are applied oldest-first to the same customer or vendor&apos;s open documents.
                                {preview.business.partiallyPaid > 0 && ` ${preview.business.partiallyPaid} partially paid.`}
                                {preview.business.unallocatedPayments > 0 &&
                                    ` ${preview.business.unallocatedPayments} payment(s) carry ${fmtAmount(preview.business.unallocatedAmount)} with no open document to settle.`}
                            </p>
                            {preview.business.skippedSamples.length > 0 && (
                                <details className="text-xs text-foreground-muted">
                                    <summary className="cursor-pointer">
                                        {preview.business.skipped} document-like transaction(s) stay plain ledger entries
                                    </summary>
                                    <ul className="mt-1 space-y-0.5 font-mono">
                                        {preview.business.skippedSamples.map((s, i) => (
                                            <li key={i}>
                                                {s.date} {s.type} {s.name ? `"${s.name}"` : ''} — {s.reason}
                                            </li>
                                        ))}
                                    </ul>
                                </details>
                            )}
                        </div>
                    )}

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
                                            <th className="text-right px-3 py-2 font-medium">Amount</th>
                                            <th className="text-right px-3 py-2 font-medium">Splits</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {preview.sampleTransactions.map((t, i) => (
                                            <tr key={i} className="border-t border-border">
                                                <td className="px-3 py-1.5 font-mono text-foreground-secondary whitespace-nowrap">{t.date}</td>
                                                <td className="px-3 py-1.5 text-foreground max-w-[20rem] truncate">{t.description}</td>
                                                <td className="px-3 py-1.5 font-mono text-right text-foreground-secondary whitespace-nowrap">
                                                    {fmtAmount(t.amount)}
                                                </td>
                                                <td className="px-3 py-1.5 font-mono text-right text-foreground-muted">{t.lines}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    {/* Errors */}
                    {preview.errors.length > 0 && (
                        <div className="bg-negative/10 border border-negative/30 rounded-lg p-4">
                            <h4 className="text-negative font-medium text-sm mb-2">
                                Excluded transactions ({preview.errorCount})
                            </h4>
                            <ul className="text-xs text-negative/80 font-mono space-y-1 max-h-40 overflow-y-auto">
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
                        <div className="bg-warning/10 border border-warning/30 rounded-lg p-4">
                            <h4 className="text-warning font-medium text-sm mb-2">
                                Warnings ({preview.warnings.length})
                            </h4>
                            <ul className="text-xs text-warning/80 space-y-1 max-h-40 overflow-y-auto">
                                {preview.warnings.map((w, i) => (
                                    <li key={i}>{w}</li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {error && (
                        <div className="bg-error/10 border border-error/30 rounded-lg p-4 text-sm text-error">
                            {error}
                        </div>
                    )}

                    <div className="flex gap-3">
                        <button
                            onClick={() => void handleImport()}
                            disabled={importing || preview.transactionCount === 0 || !bookName.trim()}
                            className="flex items-center gap-2 px-5 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 text-primary-foreground rounded-lg transition-colors"
                        >
                            {importing ? (
                                <>
                                    <div className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                                    Creating book and importing {preview.transactionCount} transactions...
                                </>
                            ) : (
                                `Create Book & Import ${preview.transactionCount} Transaction${preview.transactionCount === 1 ? '' : 's'}`
                            )}
                        </button>
                        <button
                            onClick={() => setPreview(null)}
                            disabled={importing}
                            className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                    {!bookName.trim() && (
                        <p className="text-xs text-foreground-muted">Enter a name for the new book to enable the import.</p>
                    )}
                </section>
            )}

            {/* Step 3: result */}
            {result && (
                <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-lg p-6 space-y-4">
                    <div className="bg-primary/10 border border-primary/30 rounded-lg p-4">
                        <h3 className="text-primary font-semibold mb-2">Import Successful</h3>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                            <div>
                                <span className="text-foreground-muted">Accounts: </span>
                                <span className="text-foreground font-mono">{result.accountsCreated}</span>
                            </div>
                            <div>
                                <span className="text-foreground-muted">Transactions: </span>
                                <span className="text-foreground font-mono">{result.transactionsCreated}</span>
                            </div>
                            <div>
                                <span className="text-foreground-muted">Splits: </span>
                                <span className="text-foreground font-mono">{result.splitsCreated}</span>
                            </div>
                            <div>
                                <span className="text-foreground-muted">Skipped (errors): </span>
                                <span className="text-foreground font-mono">{result.skippedErrors}</span>
                            </div>
                            {(
                                [
                                    ['Customers', result.customersCreated],
                                    ['Vendors', result.vendorsCreated],
                                    ['Employees', result.employeesCreated],
                                    ['Invoices', result.invoicesCreated],
                                    ['Bills', result.billsCreated],
                                    ['Payments applied', result.paymentsApplied],
                                ] as Array<[string, number | undefined]>
                            )
                                .filter(([, n]) => n !== undefined)
                                .map(([label, n]) => (
                                    <div key={label}>
                                        <span className="text-foreground-muted">{label}: </span>
                                        <span className="text-foreground font-mono">{n}</span>
                                    </div>
                                ))}
                        </div>
                        <p className="text-sm text-foreground-secondary mt-3">
                            The new book &quot;{bookName}&quot; was created. Switch to it with the book
                            switcher in the sidebar to see its accounts and transactions.
                        </p>
                    </div>

                    {result.warnings.length > 0 && (
                        <div className="bg-warning/10 border border-warning/30 rounded-lg p-4">
                            <h4 className="text-warning font-medium text-sm mb-2">
                                Warnings ({result.warnings.length})
                            </h4>
                            <ul className="text-xs text-warning/80 space-y-1 max-h-40 overflow-y-auto">
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
                            Import Another Company
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
