'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface AccountOption {
    guid: string;
    name: string;
    fullname?: string;
    account_type: string;
}

interface OrderItem {
    name: string;
    price: number;
    accountGuid: string;
}

interface MatchInfo {
    score: number;
    description: string;
    date: string;
    amount: number;
}

interface OrderCard {
    orderId: string;
    date: string;
    total: number;
    items: OrderItem[];
    match: MatchInfo | null;
    status: 'pending' | 'confirmed' | 'skipped';
}

interface ApplyResult {
    applied: number;
    failed: number;
    errors: Array<{ orderId: string; error: string }>;
}

type PageState = 'upload' | 'review' | 'applied';
type TaxHandling = 'separate' | 'rollup';
type ShippingHandling = 'separate' | 'rollup';

/* ------------------------------------------------------------------ */
/* Formatters                                                          */
/* ------------------------------------------------------------------ */

const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

/* ------------------------------------------------------------------ */
/* Main Page Component                                                 */
/* ------------------------------------------------------------------ */

export default function AmazonImportPage() {
    // Page state
    const [pageState, setPageState] = useState<PageState>('upload');

    // Upload form state
    const [creditCardAccount, setCreditCardAccount] = useState('');
    const [taxHandling, setTaxHandling] = useState<TaxHandling>('separate');
    const [shippingHandling, setShippingHandling] = useState<ShippingHandling>('separate');
    const [taxAccount, setTaxAccount] = useState('');
    const [shippingAccount, setShippingAccount] = useState('');
    const [file, setFile] = useState<File | null>(null);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);

    // Account data
    const [creditAccounts, setCreditAccounts] = useState<AccountOption[]>([]);
    const [allAccounts, setAllAccounts] = useState<AccountOption[]>([]);
    const [accountsLoading, setAccountsLoading] = useState(true);

    // Review state
    const [orders, setOrders] = useState<OrderCard[]>([]);
    const [filename, setFilename] = useState('');

    // Applied state
    const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
    const [applying, setApplying] = useState(false);

    // Drag state
    const [isDragging, setIsDragging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    /* -------------------------------------------------------------- */
    /* Fetch accounts                                                  */
    /* -------------------------------------------------------------- */

    useEffect(() => {
        let cancelled = false;

        async function fetchAccounts() {
            setAccountsLoading(true);
            try {
                const [creditRes, allRes] = await Promise.all([
                    fetch('/api/accounts?flat=true&noBalances=true&type=CREDIT,LIABILITY,BANK'),
                    fetch('/api/accounts?flat=true&noBalances=true'),
                ]);

                if (!cancelled) {
                    if (creditRes.ok) {
                        const data = await creditRes.json();
                        setCreditAccounts(
                            data.map((a: AccountOption) => ({
                                guid: a.guid,
                                name: a.name,
                                fullname: a.fullname,
                                account_type: a.account_type,
                            }))
                        );
                    }
                    if (allRes.ok) {
                        const data = await allRes.json();
                        setAllAccounts(
                            data.map((a: AccountOption) => ({
                                guid: a.guid,
                                name: a.name,
                                fullname: a.fullname,
                                account_type: a.account_type,
                            }))
                        );
                    }
                }
            } catch {
                // Accounts will just be empty
            } finally {
                if (!cancelled) setAccountsLoading(false);
            }
        }

        fetchAccounts();
        return () => { cancelled = true; };
    }, []);

    /* -------------------------------------------------------------- */
    /* File handling                                                    */
    /* -------------------------------------------------------------- */

    const handleFileDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        const droppedFile = e.dataTransfer.files[0];
        if (droppedFile && (droppedFile.name.endsWith('.csv') || droppedFile.name.endsWith('.zip'))) {
            setFile(droppedFile);
            setUploadError(null);
        } else {
            setUploadError('Please upload a .csv or .zip file.');
        }
    }, []);

    const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const selected = e.target.files?.[0];
        if (selected) {
            setFile(selected);
            setUploadError(null);
        }
    }, []);

    /* -------------------------------------------------------------- */
    /* Upload & Process                                                */
    /* -------------------------------------------------------------- */

    const handleUpload = async () => {
        if (!file || !creditCardAccount) return;

        setUploading(true);
        setUploadError(null);

        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('creditCardAccount', creditCardAccount);
            formData.append('taxHandling', taxHandling);
            formData.append('shippingHandling', shippingHandling);
            if (taxHandling === 'separate' && taxAccount) {
                formData.append('taxAccount', taxAccount);
            }
            if (shippingHandling === 'separate' && shippingAccount) {
                formData.append('shippingAccount', shippingAccount);
            }

            const res = await fetch('/api/amazon-import/upload', {
                method: 'POST',
                body: formData,
            });

            if (!res.ok) {
                const errorData = await res.json().catch(() => null);
                throw new Error(errorData?.error || `Upload failed (${res.status})`);
            }

            const data = await res.json();
            setOrders(data.orders || []);
            setFilename(file.name);
            setPageState('review');
        } catch (err) {
            setUploadError(err instanceof Error ? err.message : 'Upload failed');
        } finally {
            setUploading(false);
        }
    };

    /* -------------------------------------------------------------- */
    /* Review actions                                                  */
    /* -------------------------------------------------------------- */

    const updateOrderStatus = (orderId: string, status: 'pending' | 'confirmed' | 'skipped') => {
        setOrders(prev =>
            prev.map(o => (o.orderId === orderId ? { ...o, status } : o))
        );
    };

    const updateItemAccount = (orderId: string, itemIndex: number, accountGuid: string) => {
        setOrders(prev =>
            prev.map(o => {
                if (o.orderId !== orderId) return o;
                const newItems = [...o.items];
                newItems[itemIndex] = { ...newItems[itemIndex], accountGuid };
                return { ...o, items: newItems };
            })
        );
    };

    const confirmedCount = orders.filter(o => o.status === 'confirmed').length;
    const skippedCount = orders.filter(o => o.status === 'skipped').length;
    const matchedCount = orders.filter(o => o.match && o.match.score > 0).length;
    const unmatchedCount = orders.length - matchedCount;

    /* -------------------------------------------------------------- */
    /* Apply confirmed                                                 */
    /* -------------------------------------------------------------- */

    const handleApply = async () => {
        const confirmed = orders.filter(o => o.status === 'confirmed');
        if (confirmed.length === 0) return;

        setApplying(true);

        try {
            const res = await fetch('/api/amazon-import/apply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    orders: confirmed,
                    creditCardAccount,
                    taxHandling,
                    shippingHandling,
                    taxAccount: taxHandling === 'separate' ? taxAccount : undefined,
                    shippingAccount: shippingHandling === 'separate' ? shippingAccount : undefined,
                }),
            });

            if (!res.ok) {
                const errorData = await res.json().catch(() => null);
                throw new Error(errorData?.error || `Apply failed (${res.status})`);
            }

            const result: ApplyResult = await res.json();
            setApplyResult(result);
            setPageState('applied');
        } catch (err) {
            setApplyResult({
                applied: 0,
                failed: confirmedCount,
                errors: [{ orderId: 'all', error: err instanceof Error ? err.message : 'Apply failed' }],
            });
            setPageState('applied');
        } finally {
            setApplying(false);
        }
    };

    /* -------------------------------------------------------------- */
    /* Reset                                                           */
    /* -------------------------------------------------------------- */

    const handleReset = () => {
        setPageState('upload');
        setFile(null);
        setOrders([]);
        setFilename('');
        setApplyResult(null);
        setUploadError(null);
    };

    /* -------------------------------------------------------------- */
    /* Render: Upload State                                            */
    /* -------------------------------------------------------------- */

    if (pageState === 'upload') {
        return (
            <div className="space-y-8">
                <header>
                    <h1 className="text-3xl font-bold text-foreground">Amazon Import</h1>
                    <p className="text-foreground-muted mt-1">
                        Import Amazon order history and match to existing transactions.
                    </p>
                </header>

                {/* Import Settings */}
                <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6 space-y-6">
                    <h2 className="text-lg font-semibold text-foreground">Import Settings</h2>

                    {/* Credit Card Account */}
                    <div className="space-y-2">
                        <label className="block text-sm font-medium text-foreground-secondary">
                            Credit Card Account
                        </label>
                        <select
                            value={creditCardAccount}
                            onChange={e => setCreditCardAccount(e.target.value)}
                            disabled={accountsLoading}
                            className="w-full bg-surface-elevated border border-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
                        >
                            <option value="">
                                {accountsLoading ? 'Loading accounts...' : 'Select account...'}
                            </option>
                            {creditAccounts.map(a => (
                                <option key={a.guid} value={a.guid}>
                                    {a.fullname || a.name}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* Tax and Shipping - side by side on desktop */}
                    <div className="grid gap-6 sm:grid-cols-2">
                        {/* Tax Handling */}
                        <div className="space-y-3">
                            <label className="block text-sm font-medium text-foreground-secondary">
                                Tax Handling
                            </label>
                            <div className="space-y-2">
                                <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                                    <input
                                        type="radio"
                                        name="taxHandling"
                                        value="separate"
                                        checked={taxHandling === 'separate'}
                                        onChange={() => setTaxHandling('separate')}
                                        className="accent-primary"
                                    />
                                    Separate split
                                </label>
                                <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                                    <input
                                        type="radio"
                                        name="taxHandling"
                                        value="rollup"
                                        checked={taxHandling === 'rollup'}
                                        onChange={() => setTaxHandling('rollup')}
                                        className="accent-primary"
                                    />
                                    Roll into items
                                </label>
                            </div>

                            {/* Tax Account (conditional) */}
                            {taxHandling === 'separate' && (
                                <div className="space-y-1.5 mt-2">
                                    <label className="block text-xs font-medium text-foreground-muted">
                                        Tax Account
                                    </label>
                                    <select
                                        value={taxAccount}
                                        onChange={e => setTaxAccount(e.target.value)}
                                        disabled={accountsLoading}
                                        className="w-full bg-surface-elevated border border-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
                                    >
                                        <option value="">Select account...</option>
                                        {allAccounts.map(a => (
                                            <option key={a.guid} value={a.guid}>
                                                {a.fullname || a.name}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </div>

                        {/* Shipping Handling */}
                        <div className="space-y-3">
                            <label className="block text-sm font-medium text-foreground-secondary">
                                Shipping
                            </label>
                            <div className="space-y-2">
                                <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                                    <input
                                        type="radio"
                                        name="shippingHandling"
                                        value="separate"
                                        checked={shippingHandling === 'separate'}
                                        onChange={() => setShippingHandling('separate')}
                                        className="accent-primary"
                                    />
                                    Separate split
                                </label>
                                <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                                    <input
                                        type="radio"
                                        name="shippingHandling"
                                        value="rollup"
                                        checked={shippingHandling === 'rollup'}
                                        onChange={() => setShippingHandling('rollup')}
                                        className="accent-primary"
                                    />
                                    Roll into items
                                </label>
                            </div>

                            {/* Shipping Account (conditional) */}
                            {shippingHandling === 'separate' && (
                                <div className="space-y-1.5 mt-2">
                                    <label className="block text-xs font-medium text-foreground-muted">
                                        Shipping Account
                                    </label>
                                    <select
                                        value={shippingAccount}
                                        onChange={e => setShippingAccount(e.target.value)}
                                        disabled={accountsLoading}
                                        className="w-full bg-surface-elevated border border-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
                                    >
                                        <option value="">Select account...</option>
                                        {allAccounts.map(a => (
                                            <option key={a.guid} value={a.guid}>
                                                {a.fullname || a.name}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </div>
                    </div>
                </section>

                {/* File Upload */}
                <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6 space-y-4">
                    <h2 className="text-lg font-semibold text-foreground">File Upload</h2>

                    <div
                        onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                        onDragLeave={() => setIsDragging(false)}
                        onDrop={handleFileDrop}
                        onClick={() => fileInputRef.current?.click()}
                        className={`relative flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 cursor-pointer transition-colors
                            ${isDragging
                                ? 'border-primary bg-primary/5'
                                : file
                                    ? 'border-primary/50 bg-primary/5'
                                    : 'border-border hover:border-border-hover hover:bg-surface-hover/30'
                            }`}
                    >
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".csv,.zip"
                            onChange={handleFileSelect}
                            className="hidden"
                        />

                        {/* Upload icon */}
                        <svg className={`w-10 h-10 ${file ? 'text-primary' : 'text-foreground-muted'}`} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                        </svg>

                        {file ? (
                            <div className="text-center">
                                <p className="text-sm font-medium text-primary">{file.name}</p>
                                <p className="text-xs text-foreground-muted mt-1">
                                    {(file.size / 1024).toFixed(1)} KB
                                </p>
                            </div>
                        ) : (
                            <div className="text-center">
                                <p className="text-sm text-foreground-secondary">
                                    Drag and drop your file here, or click to browse
                                </p>
                                <p className="text-xs text-foreground-muted mt-1">
                                    Accepts .csv and .zip files
                                </p>
                            </div>
                        )}
                    </div>

                    {/* Error */}
                    {uploadError && (
                        <div className="flex items-center gap-2 text-sm text-error bg-error/10 border border-error/20 rounded-md px-3 py-2">
                            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                            </svg>
                            {uploadError}
                        </div>
                    )}

                    {/* Upload Button */}
                    <button
                        onClick={handleUpload}
                        disabled={!file || !creditCardAccount || uploading}
                        className="w-full px-4 py-2.5 rounded-md text-sm font-medium transition-colors
                            bg-primary text-primary-foreground hover:bg-primary-hover
                            disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {uploading ? (
                            <span className="flex items-center justify-center gap-2">
                                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                                Processing...
                            </span>
                        ) : (
                            'Upload & Process'
                        )}
                    </button>
                </section>
            </div>
        );
    }

    /* -------------------------------------------------------------- */
    /* Render: Review State                                            */
    /* -------------------------------------------------------------- */

    if (pageState === 'review') {
        return (
            <div className="space-y-6">
                {/* Header */}
                <header>
                    <h1 className="text-3xl font-bold text-foreground">
                        Import: {filename}
                        <span className="ml-2 text-lg font-normal text-foreground-muted">
                            ({orders.length} orders)
                        </span>
                    </h1>
                </header>

                {/* Status Bar */}
                <div className="flex flex-wrap gap-4 bg-surface/30 backdrop-blur-xl border border-border rounded-xl px-6 py-4">
                    <StatusBadge label="Matched" value={matchedCount} total={orders.length} color="text-primary" />
                    <StatusBadge label="Unmatched" value={unmatchedCount} color="text-warning" />
                    <StatusBadge label="Confirmed" value={confirmedCount} color="text-success" />
                    <StatusBadge label="Skipped" value={skippedCount} color="text-foreground-muted" />
                </div>

                {/* Order Cards */}
                <div className="space-y-4">
                    {orders.map(order => (
                        <div
                            key={order.orderId}
                            className={`bg-surface/30 backdrop-blur-xl border rounded-xl p-6 transition-colors
                                ${order.status === 'confirmed'
                                    ? 'border-success/30'
                                    : order.status === 'skipped'
                                        ? 'border-border opacity-60'
                                        : 'border-border'
                                }`}
                        >
                            {/* Order header */}
                            <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
                                <div>
                                    <h3 className="text-sm font-semibold text-foreground font-mono">
                                        {order.orderId}
                                    </h3>
                                    <p className="text-xs text-foreground-muted font-mono mt-0.5">
                                        {order.date}
                                    </p>
                                </div>
                                <span className="text-lg font-semibold text-foreground font-mono">
                                    {fmt.format(order.total)}
                                </span>
                            </div>

                            {/* Items */}
                            <div className="space-y-3 mb-4">
                                {order.items.map((item, idx) => (
                                    <div key={idx} className="flex flex-wrap items-center gap-3">
                                        <span className="flex-1 min-w-[200px] text-sm text-foreground truncate">
                                            {item.name}
                                        </span>
                                        <span className="text-sm font-mono text-foreground-secondary w-20 text-right">
                                            {fmt.format(item.price)}
                                        </span>
                                        <select
                                            value={item.accountGuid}
                                            onChange={e => updateItemAccount(order.orderId, idx, e.target.value)}
                                            className="w-64 bg-surface-elevated border border-border rounded-md px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
                                        >
                                            <option value="">Select account...</option>
                                            {allAccounts.map(a => (
                                                <option key={a.guid} value={a.guid}>
                                                    {a.fullname || a.name}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                ))}
                            </div>

                            {/* Match info */}
                            {order.match && order.match.score > 0 && (
                                <div className="bg-surface-elevated/50 rounded-md px-4 py-3 mb-4">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="text-xs font-medium text-foreground-muted">Match</span>
                                        <span className={`text-xs font-semibold font-mono ${
                                            order.match.score >= 90 ? 'text-success' :
                                            order.match.score >= 70 ? 'text-warning' :
                                            'text-negative'
                                        }`}>
                                            {order.match.score}%
                                        </span>
                                    </div>
                                    <p className="text-sm text-foreground-secondary truncate">
                                        {order.match.description}
                                    </p>
                                    <p className="text-xs text-foreground-muted font-mono">
                                        {order.match.date} &middot; {fmt.format(order.match.amount)}
                                    </p>
                                </div>
                            )}

                            {/* Action buttons */}
                            <div className="flex gap-2">
                                <button
                                    onClick={() => updateOrderStatus(order.orderId, 'confirmed')}
                                    disabled={order.status === 'confirmed'}
                                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                                        ${order.status === 'confirmed'
                                            ? 'bg-success/20 text-success border border-success/30'
                                            : 'bg-surface-elevated text-foreground-secondary hover:bg-success/10 hover:text-success border border-border hover:border-success/30'
                                        }`}
                                >
                                    {order.status === 'confirmed' ? 'Confirmed' : 'Confirm'}
                                </button>
                                <button
                                    onClick={() => updateOrderStatus(order.orderId, order.status === 'skipped' ? 'pending' : 'skipped')}
                                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                                        ${order.status === 'skipped'
                                            ? 'bg-foreground-muted/20 text-foreground-muted border border-foreground-muted/30'
                                            : 'bg-surface-elevated text-foreground-secondary hover:bg-surface-hover border border-border'
                                        }`}
                                >
                                    {order.status === 'skipped' ? 'Unskip' : 'Skip'}
                                </button>
                            </div>
                        </div>
                    ))}
                </div>

                {/* Apply button */}
                <div className="sticky bottom-4 flex justify-end">
                    <button
                        onClick={handleApply}
                        disabled={confirmedCount === 0 || applying}
                        className="px-6 py-3 rounded-md text-sm font-medium transition-colors shadow-lg
                            bg-primary text-primary-foreground hover:bg-primary-hover
                            disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {applying ? (
                            <span className="flex items-center gap-2">
                                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                                Applying...
                            </span>
                        ) : (
                            `Apply All Confirmed (${confirmedCount})`
                        )}
                    </button>
                </div>
            </div>
        );
    }

    /* -------------------------------------------------------------- */
    /* Render: Applied State                                           */
    /* -------------------------------------------------------------- */

    return (
        <div className="space-y-8">
            <header>
                <h1 className="text-3xl font-bold text-foreground">Import Complete</h1>
            </header>

            {/* Summary */}
            <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6 space-y-4">
                <div className="flex gap-8">
                    <div>
                        <p className="text-xs font-medium text-foreground-muted uppercase tracking-wider">Applied</p>
                        <p className="text-2xl font-bold font-mono text-success">
                            {applyResult?.applied ?? 0}
                        </p>
                    </div>
                    {(applyResult?.failed ?? 0) > 0 && (
                        <div>
                            <p className="text-xs font-medium text-foreground-muted uppercase tracking-wider">Failed</p>
                            <p className="text-2xl font-bold font-mono text-negative">
                                {applyResult?.failed ?? 0}
                            </p>
                        </div>
                    )}
                </div>

                {/* Error list */}
                {applyResult?.errors && applyResult.errors.length > 0 && (
                    <div className="space-y-2 mt-4">
                        <h3 className="text-sm font-medium text-negative">Errors</h3>
                        {applyResult.errors.map((err, idx) => (
                            <div key={idx} className="flex gap-2 text-sm bg-error/10 border border-error/20 rounded-md px-3 py-2">
                                <span className="font-mono text-foreground-secondary shrink-0">{err.orderId}</span>
                                <span className="text-error">{err.error}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Reset button */}
            <button
                onClick={handleReset}
                className="px-4 py-2.5 rounded-md text-sm font-medium transition-colors
                    bg-primary text-primary-foreground hover:bg-primary-hover"
            >
                Import Another
            </button>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Status Badge Component                                              */
/* ------------------------------------------------------------------ */

function StatusBadge({
    label,
    value,
    total,
    color,
}: {
    label: string;
    value: number;
    total?: number;
    color: string;
}) {
    return (
        <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-foreground-muted">{label}:</span>
            <span className={`text-sm font-semibold font-mono ${color}`}>
                {value}{total !== undefined ? `/${total}` : ''}
            </span>
        </div>
    );
}
