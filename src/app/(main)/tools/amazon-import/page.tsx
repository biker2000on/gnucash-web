'use client';

import { useState, useCallback, useRef } from 'react';
import { AccountSelector } from '@/components/ui/AccountSelector';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface BatchOrderItem {
    id: number;
    name: string;
    price: number;
    quantity: number;
    tax: number;
    category: string | null;
    csvRowIndex: number;
    suggestedAccountGuid: string | null;
    suggestedAccountConfidence: number;
}

interface MatchCandidate {
    transaction_guid: string;
    description: string;
    post_date: string;
    amount: number;
    split_guid: string;
    score: number;
    score_breakdown: { amount: number; date: number };
}

interface BatchOrder {
    id: number;
    orderId: string;
    orderDate: string;
    orderTotal: number;
    chargeAmount: number | null;
    items: BatchOrderItem[];
    matchStatus: string;
    matchCandidates: MatchCandidate[];
    matchedTransactionGuid: string | null;
    // Client-side state
    selectedTransaction?: string;
    itemAccountGuids?: Record<number, string>;
    confirmed?: boolean;
    skipped?: boolean;
}

interface ImportResult {
    batchId: number;
    totalOrders: number;
    totalItems: number;
    matchedOrders: number;
    duplicateCount: number;
    errors: string[];
}

interface ApplyResult {
    applied: number;
    failed: number;
    errors: Array<{ orderId: string; error: string }>;
}

type PageState = 'upload' | 'review' | 'applied';
type TaxMode = 'separate' | 'rolled_in';
type ShippingMode = 'separate' | 'rolled_in';

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
    const [creditCardAccountGuid, setCreditCardAccountGuid] = useState('');
    const [taxMode, setTaxMode] = useState<TaxMode>('separate');
    const [shippingMode, setShippingMode] = useState<ShippingMode>('separate');
    const [taxAccountGuid, setTaxAccountGuid] = useState('');
    const [shippingAccountGuid, setShippingAccountGuid] = useState('');
    const [file, setFile] = useState<File | null>(null);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);

    // Review state
    const [batchId, setBatchId] = useState<number | null>(null);
    const [orders, setOrders] = useState<BatchOrder[]>([]);
    const [filename, setFilename] = useState('');
    const [importResult, setImportResult] = useState<ImportResult | null>(null);

    // Applied state
    const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
    const [applying, setApplying] = useState(false);

    // Drag state
    const [isDragging, setIsDragging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

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
        if (!file || !creditCardAccountGuid) return;

        setUploading(true);
        setUploadError(null);

        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('creditCardAccountGuid', creditCardAccountGuid);
            formData.append('taxMode', taxMode);
            formData.append('shippingMode', shippingMode);
            if (taxMode === 'separate' && taxAccountGuid) {
                formData.append('taxAccountGuid', taxAccountGuid);
            }
            if (shippingMode === 'separate' && shippingAccountGuid) {
                formData.append('shippingAccountGuid', shippingAccountGuid);
            }

            const res = await fetch('/api/amazon/import', {
                method: 'POST',
                body: formData,
            });

            if (!res.ok) {
                const errorData = await res.json().catch(() => null);
                throw new Error(errorData?.error || `Upload failed (${res.status})`);
            }

            const result: ImportResult = await res.json();
            setImportResult(result);
            setBatchId(result.batchId);
            setFilename(file.name);

            // Fetch batch details with orders and match suggestions
            const batchRes = await fetch(`/api/amazon/import/${result.batchId}`);
            if (!batchRes.ok) {
                throw new Error('Failed to load batch details');
            }
            const batchData = await batchRes.json();

            // Initialize client-side state on each order
            const ordersWithState: BatchOrder[] = batchData.orders.map((o: BatchOrder) => ({
                ...o,
                selectedTransaction: o.matchedTransactionGuid || (o.matchCandidates.length > 0 ? o.matchCandidates[0].transaction_guid : undefined),
                itemAccountGuids: Object.fromEntries(
                    o.items.map(item => [item.id, item.suggestedAccountGuid || ''])
                ),
                confirmed: o.matchStatus === 'confirmed',
                skipped: false,
            }));

            setOrders(ordersWithState);
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

    const confirmOrder = async (orderId: string) => {
        if (!batchId) return;

        const order = orders.find(o => o.orderId === orderId);
        if (!order || !order.selectedTransaction) return;

        try {
            const res = await fetch(`/api/amazon/import/${batchId}/match`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    orderId,
                    transactionGuid: order.selectedTransaction,
                    items: order.items.map(item => ({
                        itemName: item.name,
                        accountGuid: order.itemAccountGuids?.[item.id] || '',
                    })),
                }),
            });

            if (!res.ok) {
                const errorData = await res.json().catch(() => null);
                throw new Error(errorData?.error || 'Failed to confirm match');
            }

            setOrders(prev =>
                prev.map(o => (o.orderId === orderId ? { ...o, confirmed: true, skipped: false } : o))
            );
        } catch (err) {
            setUploadError(err instanceof Error ? err.message : 'Failed to confirm');
        }
    };

    const toggleSkip = (orderId: string) => {
        setOrders(prev =>
            prev.map(o => (o.orderId === orderId ? { ...o, skipped: !o.skipped, confirmed: false } : o))
        );
    };

    const updateItemAccount = (orderId: string, itemId: number, accountGuid: string) => {
        setOrders(prev =>
            prev.map(o => {
                if (o.orderId !== orderId) return o;
                return {
                    ...o,
                    itemAccountGuids: { ...o.itemAccountGuids, [itemId]: accountGuid },
                };
            })
        );
    };

    const updateSelectedTransaction = (orderId: string, txGuid: string) => {
        setOrders(prev =>
            prev.map(o => (o.orderId === orderId ? { ...o, selectedTransaction: txGuid } : o))
        );
    };

    const confirmedCount = orders.filter(o => o.confirmed).length;
    const skippedCount = orders.filter(o => o.skipped).length;
    const matchedCount = orders.filter(o => o.matchStatus === 'suggested' || o.matchStatus === 'confirmed').length;
    const unmatchedCount = orders.length - matchedCount;

    /* -------------------------------------------------------------- */
    /* Apply confirmed                                                 */
    /* -------------------------------------------------------------- */

    const handleApply = async () => {
        if (!batchId || confirmedCount === 0) return;

        setApplying(true);

        try {
            const res = await fetch(`/api/amazon/import/${batchId}/apply`, {
                method: 'POST',
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
        setBatchId(null);
        setImportResult(null);
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

                {/* How to get your data */}
                <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6 space-y-3">
                    <h2 className="text-lg font-semibold text-foreground">How to Download Your Amazon Data</h2>
                    <ol className="list-decimal list-inside space-y-2 text-sm text-foreground-secondary">
                        <li>Go to <span className="font-medium text-foreground">Amazon.com</span> and sign in</li>
                        <li>Navigate to <span className="font-medium text-foreground">Account &amp; Lists &rarr; Your Account</span></li>
                        <li>Under &ldquo;Ordering and shopping preferences&rdquo;, click <span className="font-medium text-foreground">Download order reports</span></li>
                        <li>Alternatively, use <span className="font-medium text-foreground">Request My Data</span> at <span className="font-mono text-xs bg-surface-elevated px-1.5 py-0.5 rounded">amazon.com/gp/privacycentral/dsar/preview.html</span></li>
                        <li>Select the date range you want, then download the CSV or ZIP file</li>
                    </ol>
                    <p className="text-xs text-foreground-muted">
                        The &ldquo;Request My Data&rdquo; export is recommended as it includes item-level detail. Order History Reports are also supported.
                    </p>
                </section>

                {/* Import Settings */}
                <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6 space-y-6">
                    <h2 className="text-lg font-semibold text-foreground">Import Settings</h2>

                    {/* Credit Card Account */}
                    <div className="space-y-2">
                        <label className="block text-sm font-medium text-foreground-secondary">
                            Credit Card Account
                        </label>
                        <AccountSelector
                            value={creditCardAccountGuid}
                            onChange={(guid) => setCreditCardAccountGuid(guid)}
                            placeholder="Search for account..."
                            accountTypes={['CREDIT', 'LIABILITY', 'BANK']}
                        />
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
                                        name="taxMode"
                                        value="separate"
                                        checked={taxMode === 'separate'}
                                        onChange={() => setTaxMode('separate')}
                                        className="accent-primary"
                                    />
                                    Separate split
                                </label>
                                <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                                    <input
                                        type="radio"
                                        name="taxMode"
                                        value="rolled_in"
                                        checked={taxMode === 'rolled_in'}
                                        onChange={() => setTaxMode('rolled_in')}
                                        className="accent-primary"
                                    />
                                    Roll into items
                                </label>
                            </div>

                            {/* Tax Account (conditional) */}
                            {taxMode === 'separate' && (
                                <div className="space-y-1.5 mt-2">
                                    <label className="block text-xs font-medium text-foreground-muted">
                                        Tax Account
                                    </label>
                                    <AccountSelector
                                        value={taxAccountGuid}
                                        onChange={(guid) => setTaxAccountGuid(guid)}
                                        placeholder="Search for account..."
                                        compact
                                    />
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
                                        name="shippingMode"
                                        value="separate"
                                        checked={shippingMode === 'separate'}
                                        onChange={() => setShippingMode('separate')}
                                        className="accent-primary"
                                    />
                                    Separate split
                                </label>
                                <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                                    <input
                                        type="radio"
                                        name="shippingMode"
                                        value="rolled_in"
                                        checked={shippingMode === 'rolled_in'}
                                        onChange={() => setShippingMode('rolled_in')}
                                        className="accent-primary"
                                    />
                                    Roll into items
                                </label>
                            </div>

                            {/* Shipping Account (conditional) */}
                            {shippingMode === 'separate' && (
                                <div className="space-y-1.5 mt-2">
                                    <label className="block text-xs font-medium text-foreground-muted">
                                        Shipping Account
                                    </label>
                                    <AccountSelector
                                        value={shippingAccountGuid}
                                        onChange={(guid) => setShippingAccountGuid(guid)}
                                        placeholder="Search for account..."
                                        compact
                                    />
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
                        disabled={!file || !creditCardAccountGuid || uploading}
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
                    {importResult && importResult.duplicateCount > 0 && (
                        <p className="text-sm text-foreground-muted mt-1">
                            {importResult.duplicateCount} duplicate items skipped
                        </p>
                    )}
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
                                ${order.confirmed
                                    ? 'border-success/30'
                                    : order.skipped
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
                                        {order.orderDate}
                                    </p>
                                </div>
                                <span className="text-lg font-semibold text-foreground font-mono">
                                    {fmt.format(order.orderTotal)}
                                </span>
                            </div>

                            {/* Items */}
                            <div className="space-y-3 mb-4">
                                {order.items.map(item => (
                                    <div key={item.id} className="flex flex-wrap items-center gap-3">
                                        <span className="flex-1 min-w-[200px] text-sm text-foreground truncate">
                                            {item.name}
                                        </span>
                                        <span className="text-sm font-mono text-foreground-secondary w-20 text-right">
                                            {fmt.format(item.price)}
                                        </span>
                                        <div className="w-64">
                                            <AccountSelector
                                                value={order.itemAccountGuids?.[item.id] || ''}
                                                onChange={(guid) => updateItemAccount(order.orderId, item.id, guid)}
                                                placeholder="Select account..."
                                                compact
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* Match candidates */}
                            {order.matchCandidates.length > 0 && (
                                <div className="bg-surface-elevated/50 rounded-md px-4 py-3 mb-4">
                                    <div className="flex items-center gap-2 mb-2">
                                        <span className="text-xs font-medium text-foreground-muted">
                                            {order.matchCandidates.length === 1 ? 'Match' : 'Match candidates'}
                                        </span>
                                    </div>
                                    {order.matchCandidates.map((candidate, idx) => (
                                        <label
                                            key={candidate.transaction_guid}
                                            className={`flex items-start gap-2 text-sm cursor-pointer rounded-md px-2 py-1.5 transition-colors
                                                ${order.selectedTransaction === candidate.transaction_guid ? 'bg-primary/10' : 'hover:bg-surface-hover/50'}
                                                ${idx > 0 ? 'mt-1' : ''}`}
                                        >
                                            <input
                                                type="radio"
                                                name={`match-${order.orderId}`}
                                                checked={order.selectedTransaction === candidate.transaction_guid}
                                                onChange={() => updateSelectedTransaction(order.orderId, candidate.transaction_guid)}
                                                className="accent-primary mt-1"
                                            />
                                            <div className="flex-1 min-w-0">
                                                <p className="text-foreground-secondary truncate">
                                                    {candidate.description}
                                                </p>
                                                <p className="text-xs text-foreground-muted font-mono">
                                                    {candidate.post_date} &middot; {fmt.format(candidate.amount)}
                                                </p>
                                            </div>
                                            <span className={`text-xs font-semibold font-mono shrink-0 ${
                                                candidate.score >= 0.9 ? 'text-success' :
                                                candidate.score >= 0.7 ? 'text-warning' :
                                                'text-negative'
                                            }`}>
                                                {Math.round(candidate.score * 100)}%
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            )}

                            {/* No match info */}
                            {order.matchCandidates.length === 0 && order.matchStatus === 'unmatched' && (
                                <div className="bg-warning/5 border border-warning/20 rounded-md px-4 py-3 mb-4">
                                    <p className="text-xs text-warning font-medium">
                                        No matching transaction found
                                    </p>
                                    <p className="text-xs text-foreground-muted mt-0.5">
                                        This order couldn&apos;t be matched to any credit card transaction. You can skip it or manually reconcile later.
                                    </p>
                                </div>
                            )}

                            {/* Action buttons */}
                            <div className="flex gap-2">
                                <button
                                    onClick={() => confirmOrder(order.orderId)}
                                    disabled={order.confirmed || !order.selectedTransaction}
                                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                                        ${order.confirmed
                                            ? 'bg-success/20 text-success border border-success/30'
                                            : 'bg-surface-elevated text-foreground-secondary hover:bg-success/10 hover:text-success border border-border hover:border-success/30'
                                        } disabled:opacity-40 disabled:cursor-not-allowed`}
                                >
                                    {order.confirmed ? 'Confirmed' : 'Confirm'}
                                </button>
                                <button
                                    onClick={() => toggleSkip(order.orderId)}
                                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                                        ${order.skipped
                                            ? 'bg-foreground-muted/20 text-foreground-muted border border-foreground-muted/30'
                                            : 'bg-surface-elevated text-foreground-secondary hover:bg-surface-hover border border-border'
                                        }`}
                                >
                                    {order.skipped ? 'Unskip' : 'Skip'}
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
