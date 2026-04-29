'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/format';

export interface DrilldownTarget {
    accountGuid: string;
    accountName: string;
    periodLabel: string;
    startDate: string;
    endDate: string;
}

interface DrilldownRow {
    txGuid: string;
    splitGuid: string;
    date: string;
    description: string;
    accountGuid: string;
    accountName: string;
    amount: number;
}

interface DrilldownResponse {
    transactions: DrilldownRow[];
    total: number;
}

interface Props {
    target: DrilldownTarget | null;
    onClose: () => void;
}

export function TransactionDrilldownModal({ target, onClose }: Props) {
    const [data, setData] = useState<DrilldownResponse | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const closeBtnRef = useRef<HTMLButtonElement>(null);

    // Fetch on target change
    useEffect(() => {
        if (!target) return;
        let cancelled = false;
        setIsLoading(true);
        setError(null);
        setData(null);

        const params = new URLSearchParams({
            accountGuid: target.accountGuid,
            startDate: target.startDate,
            endDate: target.endDate,
        });

        fetch(`/api/reports/income-statement-by-period/transactions?${params}`)
            .then(async res => {
                if (!res.ok) throw new Error(`Failed (${res.status})`);
                return (await res.json()) as DrilldownResponse;
            })
            .then(json => {
                if (!cancelled) setData(json);
            })
            .catch(err => {
                if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [target]);

    // Esc to close + focus close button on open
    useEffect(() => {
        if (!target) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        closeBtnRef.current?.focus();
        return () => window.removeEventListener('keydown', onKey);
    }, [target, onClose]);

    if (!target) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50"
            onClick={onClose}
            aria-hidden="false"
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={`Transactions for ${target.accountName} ${target.periodLabel}`}
                className="w-full sm:max-w-3xl sm:max-h-[80vh] max-h-[90vh] flex flex-col bg-background border border-border sm:rounded-lg shadow-xl overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-start justify-between gap-4 px-4 py-3 border-b border-border">
                    <div>
                        <div className="text-base font-semibold text-foreground">{target.accountName}</div>
                        <div className="text-xs text-foreground-muted">{target.periodLabel}</div>
                    </div>
                    <button
                        ref={closeBtnRef}
                        onClick={onClose}
                        aria-label="Close"
                        className="text-foreground-muted hover:text-foreground p-1 rounded"
                    >
                        ✕
                    </button>
                </div>

                {/* Sub-header: count + total */}
                {data && (
                    <div className="flex items-center justify-between px-4 py-2 text-xs text-foreground-secondary bg-background-tertiary/30 border-b border-border">
                        <span>
                            {data.transactions.length}{' '}
                            {data.transactions.length === 1 ? 'transaction' : 'transactions'}
                        </span>
                        <span
                            className={`font-mono font-medium ${
                                data.total >= 0 ? 'text-foreground-secondary' : 'text-rose-400'
                            }`}
                        >
                            {formatCurrency(data.total, 'USD')}
                        </span>
                    </div>
                )}

                {/* Body */}
                <div className="flex-1 overflow-y-auto">
                    {isLoading && <DrilldownSkeleton />}
                    {error && (
                        <div className="px-4 py-6 text-sm text-rose-400">
                            {error}
                        </div>
                    )}
                    {data && data.transactions.length === 0 && !isLoading && (
                        <div className="px-4 py-6 text-sm text-foreground-muted text-center">
                            No transactions in this period.
                        </div>
                    )}
                    {data && data.transactions.length > 0 && (
                        <DrilldownRows rows={data.transactions} />
                    )}
                </div>
            </div>
        </div>
    );
}

function DrilldownSkeleton() {
    return (
        <ul className="divide-y divide-border/30">
            {Array.from({ length: 5 }).map((_, i) => (
                <li key={i} className="px-4 py-3 animate-pulse">
                    <div className="h-3 w-24 bg-surface-hover rounded mb-2" />
                    <div className="h-3 w-3/4 bg-surface-hover rounded" />
                </li>
            ))}
        </ul>
    );
}

function DrilldownRows({ rows }: { rows: DrilldownRow[] }) {
    return (
        <>
            {/* Desktop table */}
            <table className="hidden sm:table w-full text-sm">
                <thead className="sticky top-0 bg-background-tertiary/80 backdrop-blur-sm">
                    <tr className="border-b border-border">
                        <th className="text-left px-4 py-2 text-xs uppercase tracking-wider text-foreground-muted font-medium">Date</th>
                        <th className="text-left px-3 py-2 text-xs uppercase tracking-wider text-foreground-muted font-medium">Description</th>
                        <th className="text-left px-3 py-2 text-xs uppercase tracking-wider text-foreground-muted font-medium">Account</th>
                        <th className="text-right px-4 py-2 text-xs uppercase tracking-wider text-foreground-muted font-medium">Amount</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map(r => (
                        <tr key={r.splitGuid} className="border-b border-border/30 hover:bg-surface-hover/30">
                            <td className="px-4 py-2 whitespace-nowrap text-foreground-secondary">
                                <Link
                                    href={`/accounts/${r.accountGuid}#tx-${r.txGuid}`}
                                    className="hover:underline"
                                >
                                    {r.date}
                                </Link>
                            </td>
                            <td className="px-3 py-2 text-foreground">{r.description || <span className="text-foreground-muted">—</span>}</td>
                            <td className="px-3 py-2 text-foreground-secondary">{r.accountName}</td>
                            <td className={`px-4 py-2 text-right font-mono ${r.amount >= 0 ? 'text-foreground' : 'text-rose-400'}`}>
                                {formatCurrency(r.amount, 'USD')}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>

            {/* Mobile card list */}
            <ul className="sm:hidden divide-y divide-border/30">
                {rows.map(r => (
                    <li key={r.splitGuid}>
                        <Link
                            href={`/accounts/${r.accountGuid}#tx-${r.txGuid}`}
                            className="block px-4 py-3 hover:bg-surface-hover/30"
                        >
                            <div className="flex items-baseline justify-between gap-3">
                                <span className="text-xs text-foreground-secondary">{r.date}</span>
                                <span className={`font-mono text-sm ${r.amount >= 0 ? 'text-foreground' : 'text-rose-400'}`}>
                                    {formatCurrency(r.amount, 'USD')}
                                </span>
                            </div>
                            <div className="text-sm text-foreground mt-0.5 truncate">
                                {r.description || <span className="text-foreground-muted">—</span>}
                            </div>
                            <div className="text-xs text-foreground-muted mt-0.5 truncate">{r.accountName}</div>
                        </Link>
                    </li>
                ))}
            </ul>
        </>
    );
}
