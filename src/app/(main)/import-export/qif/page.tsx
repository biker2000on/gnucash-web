'use client';

import { useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { AccountSelector } from '@/components/ui/AccountSelector';

type DateFormat = 'auto' | 'us' | 'eu';

interface AccountMapping {
    qifName: string;
    qifType: string;
    guid?: string;
    path: string;
    isNew: boolean;
    transactions: number;
}

interface CategoryMapping {
    category: string;
    guid?: string;
    path: string;
    isNew: boolean;
    uses: number;
}

interface PreviewData {
    counts: {
        qifAccounts: number;
        qifTransactions: number;
        qifCategories: number;
        transactionsToCreate: number;
        splitsToCreate: number;
        accountsToCreate: number;
        duplicatesSkipped: number;
        transferPairsDeduped: number;
    };
    accountMappings: AccountMapping[];
    categoryMappings: CategoryMapping[];
    accountsToCreate: Array<{ displayPath: string; accountType: string; reason: string }>;
    sampleTransactions: Array<{
        date: string;
        description: string;
        amount: number;
        source: string;
        counterparts: string[];
    }>;
    skippedDuplicates: Array<{ qifAccount: string; date: string; amount: number; description: string }>;
    warnings: string[];
}

interface ImportResultData {
    accountsCreated: number;
    transactionsCreated: number;
    splitsCreated: number;
    duplicatesSkipped: number;
    transferPairsDeduped: number;
    warnings: string[];
}

const amountClass = (n: number) => (n < 0 ? 'text-negative' : n > 0 ? 'text-positive' : 'text-foreground-secondary');
const fmtAmount = (n: number) =>
    n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function QifImportPage() {
    const [content, setContent] = useState('');
    const [fileName, setFileName] = useState<string | null>(null);
    const [dateFormat, setDateFormat] = useState<DateFormat>('auto');
    const [dragOver, setDragOver] = useState(false);

    const [preview, setPreview] = useState<PreviewData | null>(null);
    const [previewing, setPreviewing] = useState(false);
    const [importing, setImporting] = useState(false);
    const [result, setResult] = useState<ImportResultData | null>(null);
    const [error, setError] = useState<string | null>(null);

    const [accountOverrides, setAccountOverrides] = useState<Record<string, string>>({});
    const [categoryOverrides, setCategoryOverrides] = useState<Record<string, string>>({});

    const fileInputRef = useRef<HTMLInputElement>(null);

    const loadFile = useCallback(async (file: File) => {
        try {
            const text = await file.text();
            setContent(text);
            setFileName(file.name);
            setPreview(null);
            setResult(null);
            setError(null);
        } catch {
            setError('Could not read the file.');
        }
    }, []);

    const runPreview = useCallback(
        async (
            overrides: { accounts?: Record<string, string>; categories?: Record<string, string> } = {}
        ) => {
            const accounts = overrides.accounts ?? accountOverrides;
            const categories = overrides.categories ?? categoryOverrides;
            setPreviewing(true);
            setError(null);
            try {
                const res = await fetch('/api/import/qif', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        content,
                        dateFormat,
                        dryRun: true,
                        accountMappings: accounts,
                        categoryMappings: categories,
                    }),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Preview failed');
                setPreview(data);
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Preview failed');
            } finally {
                setPreviewing(false);
            }
        },
        [content, dateFormat, accountOverrides, categoryOverrides]
    );

    const handleAccountOverride = useCallback(
        (qifName: string, guid: string) => {
            const next = { ...accountOverrides, [qifName]: guid };
            setAccountOverrides(next);
            void runPreview({ accounts: next });
        },
        [accountOverrides, runPreview]
    );

    const handleCategoryOverride = useCallback(
        (category: string, guid: string) => {
            const next = { ...categoryOverrides, [category]: guid };
            setCategoryOverrides(next);
            void runPreview({ categories: next });
        },
        [categoryOverrides, runPreview]
    );

    const handleImport = useCallback(async () => {
        setImporting(true);
        setError(null);
        try {
            const res = await fetch('/api/import/qif', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content,
                    dateFormat,
                    dryRun: false,
                    accountMappings: accountOverrides,
                    categoryMappings: categoryOverrides,
                }),
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
    }, [content, dateFormat, accountOverrides, categoryOverrides]);

    const handleReset = useCallback(() => {
        setContent('');
        setFileName(null);
        setPreview(null);
        setResult(null);
        setError(null);
        setAccountOverrides({});
        setCategoryOverrides({});
        if (fileInputRef.current) fileInputRef.current.value = '';
    }, []);

    return (
        <div className="space-y-8">
            <header>
                <h1 className="text-3xl font-bold text-foreground">Import QIF</h1>
                <p className="text-foreground-muted mt-1">
                    Import Quicken Interchange Format files into the active book.{' '}
                    <Link href="/import-export" className="text-primary hover:text-primary-hover">
                        Back to Import / Export
                    </Link>
                </p>
            </header>

            {/* Step 1: input */}
            {!result && (
                <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-6">
                    <div>
                        <h2 className="text-xl font-semibold text-foreground">QIF File</h2>
                        <p className="text-sm text-foreground-secondary mt-1">
                            Upload a .qif file or paste its contents. Bank, cash, credit card,
                            asset, and liability sections are supported.
                        </p>
                    </div>

                    <div
                        onDrop={(e) => {
                            e.preventDefault();
                            setDragOver(false);
                            const file = e.dataTransfer.files?.[0];
                            if (file) void loadFile(file);
                        }}
                        onDragOver={(e) => {
                            e.preventDefault();
                            setDragOver(true);
                        }}
                        onDragLeave={(e) => {
                            e.preventDefault();
                            setDragOver(false);
                        }}
                        onClick={() => fileInputRef.current?.click()}
                        className={`relative border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all
                            ${dragOver
                                ? 'border-primary bg-primary/10'
                                : 'border-border hover:border-foreground-secondary hover:bg-surface/50'
                            }`}
                    >
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".qif,.txt"
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) void loadFile(file);
                            }}
                            className="hidden"
                        />
                        <p className="text-foreground-secondary text-sm">
                            {fileName ? (
                                <span className="text-foreground font-medium">{fileName}</span>
                            ) : (
                                'Drop a .qif file here or click to browse'
                            )}
                        </p>
                    </div>

                    <div>
                        <label className="block text-sm text-foreground-secondary mb-1" htmlFor="qif-content">
                            Or paste QIF content
                        </label>
                        <textarea
                            id="qif-content"
                            value={content}
                            onChange={(e) => {
                                setContent(e.target.value);
                                setPreview(null);
                            }}
                            rows={8}
                            spellCheck={false}
                            placeholder={'!Type:Bank\nD01/15/2026\nT-42.50\nPGrocery Store\nLFood:Groceries\n^'}
                            className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm font-mono text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
                        />
                    </div>

                    <div className="flex flex-col sm:flex-row sm:items-end gap-4">
                        <div>
                            <label className="block text-sm text-foreground-secondary mb-1" htmlFor="qif-date-format">
                                Date format
                            </label>
                            <select
                                id="qif-date-format"
                                value={dateFormat}
                                onChange={(e) => {
                                    setDateFormat(e.target.value as DateFormat);
                                    setPreview(null);
                                }}
                                className="bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                            >
                                <option value="auto">Auto-detect</option>
                                <option value="us">US (MM/DD)</option>
                                <option value="eu">EU (DD/MM)</option>
                            </select>
                        </div>
                        <div className="flex gap-3">
                            <button
                                onClick={() => void runPreview()}
                                disabled={previewing || !content.trim()}
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
                            {(content || preview) && (
                                <button
                                    onClick={handleReset}
                                    className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                                >
                                    Clear
                                </button>
                            )}
                        </div>
                    </div>

                    {error && (
                        <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-4 text-sm text-rose-400">
                            {error}
                        </div>
                    )}
                </section>
            )}

            {/* Step 2: preview */}
            {preview && !result && (
                <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-6">
                    <h2 className="text-xl font-semibold text-foreground">Preview</h2>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                        <div className="bg-surface/50 border border-border rounded-lg p-3">
                            <div className="text-foreground-muted text-xs">Transactions</div>
                            <div className="text-foreground font-mono text-lg">{preview.counts.transactionsToCreate}</div>
                        </div>
                        <div className="bg-surface/50 border border-border rounded-lg p-3">
                            <div className="text-foreground-muted text-xs">New accounts</div>
                            <div className="text-foreground font-mono text-lg">{preview.counts.accountsToCreate}</div>
                        </div>
                        <div className="bg-surface/50 border border-border rounded-lg p-3">
                            <div className="text-foreground-muted text-xs">Duplicates skipped</div>
                            <div className="text-foreground font-mono text-lg">{preview.counts.duplicatesSkipped}</div>
                        </div>
                        <div className="bg-surface/50 border border-border rounded-lg p-3">
                            <div className="text-foreground-muted text-xs">Transfers merged</div>
                            <div className="text-foreground font-mono text-lg">{preview.counts.transferPairsDeduped}</div>
                        </div>
                    </div>

                    {/* Account mappings */}
                    <div className="space-y-2">
                        <h3 className="text-sm font-semibold text-foreground">Account targets</h3>
                        <p className="text-xs text-foreground-muted">
                            Where each QIF account&apos;s transactions will be posted. Override with an existing account if needed.
                        </p>
                        <div className="space-y-2">
                            {preview.accountMappings.map((m) => (
                                <div
                                    key={m.qifName || '(default)'}
                                    className="flex flex-col sm:flex-row sm:items-center gap-2 bg-surface/50 border border-border rounded-lg p-3"
                                >
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm text-foreground truncate">
                                            {m.qifName || '(unnamed account)'}
                                            <span className="ml-2 text-xs text-foreground-muted uppercase">{m.qifType}</span>
                                        </div>
                                        <div className="text-xs text-foreground-muted font-mono">
                                            {m.transactions} transaction{m.transactions === 1 ? '' : 's'} →{' '}
                                            {m.isNew ? (
                                                <span className="text-warning">create &quot;{m.path}&quot;</span>
                                            ) : (
                                                m.path
                                            )}
                                        </div>
                                    </div>
                                    <div className="w-full sm:w-72">
                                        <AccountSelector
                                            value={m.guid ?? ''}
                                            onChange={(guid) => handleAccountOverride(m.qifName, guid)}
                                            placeholder={m.isNew ? 'Map to existing account...' : m.path}
                                            compact
                                        />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Category mappings */}
                    {preview.categoryMappings.length > 0 && (
                        <div className="space-y-2">
                            <h3 className="text-sm font-semibold text-foreground">Category mappings</h3>
                            <div className="space-y-2">
                                {preview.categoryMappings.map((m) => (
                                    <div
                                        key={m.category}
                                        className="flex flex-col sm:flex-row sm:items-center gap-2 bg-surface/50 border border-border rounded-lg p-3"
                                    >
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm text-foreground truncate">{m.category}</div>
                                            <div className="text-xs text-foreground-muted font-mono">
                                                {m.uses} use{m.uses === 1 ? '' : 's'} →{' '}
                                                {m.isNew ? (
                                                    <span className="text-warning">create &quot;{m.path}&quot;</span>
                                                ) : (
                                                    m.path
                                                )}
                                            </div>
                                        </div>
                                        <div className="w-full sm:w-72">
                                            <AccountSelector
                                                value={m.guid ?? ''}
                                                onChange={(guid) => handleCategoryOverride(m.category, guid)}
                                                placeholder={m.isNew ? 'Map to existing account...' : m.path}
                                                accountTypes={['INCOME', 'EXPENSE']}
                                                compact
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* New accounts */}
                    {preview.accountsToCreate.length > 0 && (
                        <div className="space-y-2">
                            <h3 className="text-sm font-semibold text-foreground">
                                Accounts to create ({preview.accountsToCreate.length})
                            </h3>
                            <ul className="text-xs text-foreground-secondary font-mono space-y-1 max-h-40 overflow-y-auto">
                                {preview.accountsToCreate.map((a) => (
                                    <li key={a.displayPath}>
                                        {a.displayPath}{' '}
                                        <span className="text-foreground-muted uppercase">{a.accountType}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {/* Sample transactions */}
                    {preview.sampleTransactions.length > 0 && (
                        <div className="space-y-2">
                            <h3 className="text-sm font-semibold text-foreground">
                                Transactions (first {preview.sampleTransactions.length} of {preview.counts.transactionsToCreate})
                            </h3>
                            <div className="overflow-x-auto border border-border rounded-lg">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="text-xs text-foreground-muted uppercase tracking-wider bg-surface/50">
                                            <th className="text-left px-3 py-2 font-medium">Date</th>
                                            <th className="text-left px-3 py-2 font-medium">Description</th>
                                            <th className="text-right px-3 py-2 font-medium">Amount</th>
                                            <th className="text-left px-3 py-2 font-medium">Account</th>
                                            <th className="text-left px-3 py-2 font-medium">Counterpart</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {preview.sampleTransactions.map((t, i) => (
                                            <tr key={i} className="border-t border-border">
                                                <td className="px-3 py-1.5 font-mono text-foreground-secondary whitespace-nowrap">{t.date}</td>
                                                <td className="px-3 py-1.5 text-foreground max-w-[16rem] truncate">{t.description}</td>
                                                <td className={`px-3 py-1.5 font-mono text-right whitespace-nowrap ${amountClass(t.amount)}`}>
                                                    {fmtAmount(t.amount)}
                                                </td>
                                                <td className="px-3 py-1.5 text-foreground-secondary max-w-[14rem] truncate">{t.source}</td>
                                                <td className="px-3 py-1.5 text-foreground-secondary max-w-[14rem] truncate">
                                                    {t.counterparts.join(', ')}
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
                                Duplicates skipped ({preview.counts.duplicatesSkipped})
                            </h4>
                            <ul className="text-xs text-foreground-muted font-mono space-y-1 max-h-40 overflow-y-auto">
                                {preview.skippedDuplicates.map((d, i) => (
                                    <li key={i}>
                                        {d.date} {fmtAmount(d.amount)} — {d.description} ({d.qifAccount})
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

                    <div className="flex gap-3">
                        <button
                            onClick={handleImport}
                            disabled={importing || preview.counts.transactionsToCreate === 0}
                            className="flex items-center gap-2 px-5 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 text-primary-foreground rounded-xl transition-colors"
                        >
                            {importing ? (
                                <>
                                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    Importing...
                                </>
                            ) : (
                                `Import ${preview.counts.transactionsToCreate} Transaction${preview.counts.transactionsToCreate === 1 ? '' : 's'}`
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
                </section>
            )}

            {/* Step 3: result */}
            {result && (
                <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-4">
                    <div className="bg-primary/10 border border-primary/30 rounded-lg p-4">
                        <h3 className="text-primary font-semibold mb-2">Import Successful</h3>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
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
                                <span className="text-foreground-muted">Transfers merged: </span>
                                <span className="text-foreground font-mono">{result.transferPairsDeduped}</span>
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
