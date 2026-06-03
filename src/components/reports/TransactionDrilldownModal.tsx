'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

type SortKey = keyof Pick<DrilldownRow, 'date' | 'description' | 'accountName' | 'amount'>;
type SortDirection = 'asc' | 'desc';

interface Props {
    target: DrilldownTarget | null;
    onClose: () => void;
}

export function TransactionDrilldownModal({ target, onClose }: Props) {
    const [data, setData] = useState<DrilldownResponse | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [globalFilter, setGlobalFilter] = useState('');
    const [sortKey, setSortKey] = useState<SortKey>('date');
    const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
    const closeBtnRef = useRef<HTMLButtonElement>(null);

    // Fetch on target change
    useEffect(() => {
        if (!target) return;
        let cancelled = false;

        queueMicrotask(() => {
            if (cancelled) return;
            setIsLoading(true);
            setError(null);
            setData(null);
            setGlobalFilter('');
            setSortKey('date');
            setSortDirection('asc');

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

    const visibleRows = useMemo(() => {
        if (!data) return [];

        const filter = globalFilter.trim().toLowerCase();
        const filteredRows = filter
            ? data.transactions.filter(row => {
                const searchable = [
                    row.date,
                    row.description,
                    row.accountName,
                    formatCurrency(row.amount, 'USD'),
                    String(row.amount),
                ].join(' ').toLowerCase();
                return searchable.includes(filter);
            })
            : data.transactions;

        return [...filteredRows].sort((a, b) => {
            const direction = sortDirection === 'asc' ? 1 : -1;
            if (sortKey === 'amount') {
                return (a.amount - b.amount) * direction;
            }

            return a[sortKey].localeCompare(b[sortKey], undefined, {
                numeric: true,
                sensitivity: 'base',
            }) * direction;
        });
    }, [data, globalFilter, sortDirection, sortKey]);

    const handleSort = (key: SortKey) => {
        if (sortKey === key) {
            setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
            return;
        }
        setSortKey(key);
        setSortDirection(key === 'amount' ? 'desc' : 'asc');
    };

    if (!target || typeof document === 'undefined') return null;

    return createPortal(
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
                    <div className="px-4 py-2 bg-background-tertiary/30 border-b border-border">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <span className="text-xs text-foreground-secondary">
                                {visibleRows.length}
                                {visibleRows.length !== data.transactions.length && ` of ${data.transactions.length}`}{' '}
                                {data.transactions.length === 1 ? 'transaction' : 'transactions'}
                            </span>
                            <span
                                className={`font-mono font-medium text-xs ${
                                    data.total >= 0 ? 'text-foreground-secondary' : 'text-rose-400'
                                }`}
                            >
                                {formatCurrency(data.total, 'USD')}
                            </span>
                        </div>
                        <input
                            type="search"
                            value={globalFilter}
                            onChange={e => setGlobalFilter(e.target.value)}
                            placeholder="Filter transactions"
                            className="mt-2 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:border-primary"
                        />
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
                        visibleRows.length > 0 ? (
                            <DrilldownRows
                                rows={visibleRows}
                                sortKey={sortKey}
                                sortDirection={sortDirection}
                                onSort={handleSort}
                            />
                        ) : (
                            <div className="px-4 py-6 text-sm text-foreground-muted text-center">
                                No transactions match the current filter.
                            </div>
                        )
                    )}
                </div>
            </div>
        </div>,
        document.body,
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

function SortableHeader({
    label,
    sortKey,
    activeKey,
    direction,
    onSort,
    align = 'left',
}: {
    label: string;
    sortKey: SortKey;
    activeKey: SortKey;
    direction: SortDirection;
    onSort: (key: SortKey) => void;
    align?: 'left' | 'right';
}) {
    const isActive = activeKey === sortKey;
    const indicator = isActive ? (direction === 'asc' ? 'Asc' : 'Desc') : 'Sort';

    return (
        <th
            className={`${align === 'right' ? 'text-right' : 'text-left'} px-3 py-2 text-xs uppercase tracking-wider text-foreground-muted font-medium`}
            aria-sort={isActive ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
        >
            <button
                type="button"
                onClick={() => onSort(sortKey)}
                className={`inline-flex items-center gap-1 hover:text-foreground focus:outline-none focus:text-primary ${
                    align === 'right' ? 'justify-end w-full' : ''
                } ${isActive ? 'text-primary' : ''}`}
            >
                <span>{label}</span>
                <span aria-hidden="true" className="text-[10px]">{indicator}</span>
            </button>
        </th>
    );
}

function DrilldownRows({
    rows,
    sortKey,
    sortDirection,
    onSort,
}: {
    rows: DrilldownRow[];
    sortKey: SortKey;
    sortDirection: SortDirection;
    onSort: (key: SortKey) => void;
}) {
    return (
        <>
            {/* Desktop table */}
            <table className="hidden sm:table w-full text-sm">
                <thead className="sticky top-0 bg-background-tertiary/80 backdrop-blur-sm">
                    <tr className="border-b border-border">
                        <SortableHeader label="Date" sortKey="date" activeKey={sortKey} direction={sortDirection} onSort={onSort} />
                        <SortableHeader label="Description" sortKey="description" activeKey={sortKey} direction={sortDirection} onSort={onSort} />
                        <SortableHeader label="Account" sortKey="accountName" activeKey={sortKey} direction={sortDirection} onSort={onSort} />
                        <SortableHeader label="Amount" sortKey="amount" activeKey={sortKey} direction={sortDirection} onSort={onSort} align="right" />
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
