'use client';

/**
 * Banner showing the offline quick-add queue: pending/failed counts,
 * expandable per-item list with retry/delete, and a manual sync button.
 */

import { useState } from 'react';
import { QueuedQuickAdd } from '@/lib/quick-add-queue';

interface PendingQueueBannerProps {
    items: QueuedQuickAdd[];
    isSyncing: boolean;
    isOnline: boolean;
    onSync: () => void;
    onRetry: (localId: string) => void;
    onRemove: (localId: string) => void;
}

function itemAmount(item: QueuedQuickAdd): string {
    const split = item.payload.splits.find(s => s.value_num > 0) ?? item.payload.splits[0];
    if (!split || !split.value_denom) return '';
    return (Math.abs(split.value_num) / split.value_denom).toFixed(2);
}

const STATUS_LABEL: Record<QueuedQuickAdd['status'], string> = {
    pending: 'Queued',
    syncing: 'Syncing…',
    failed: 'Failed',
};

export function PendingQueueBanner({
    items,
    isSyncing,
    isOnline,
    onSync,
    onRetry,
    onRemove,
}: PendingQueueBannerProps) {
    const [expanded, setExpanded] = useState(false);

    if (items.length === 0) return null;

    const failedCount = items.filter(i => i.status === 'failed').length;

    return (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2">
                <button
                    type="button"
                    onClick={() => setExpanded(e => !e)}
                    className="flex-1 min-h-[44px] flex items-center gap-2 text-left"
                    aria-expanded={expanded}
                >
                    <span className="w-2 h-2 rounded-full bg-warning flex-shrink-0" aria-hidden="true" />
                    <span className="text-sm text-foreground">
                        {items.length} {items.length === 1 ? 'transaction' : 'transactions'} queued
                        {failedCount > 0 && (
                            <span className="text-negative"> · {failedCount} failed</span>
                        )}
                    </span>
                    <svg
                        className={`w-4 h-4 text-foreground-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        viewBox="0 0 24 24"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                </button>
                {isOnline ? (
                    <button
                        type="button"
                        onClick={onSync}
                        disabled={isSyncing}
                        className="min-h-[44px] px-3 rounded-lg text-sm text-primary hover:bg-primary-light disabled:opacity-50 transition-colors"
                    >
                        {isSyncing ? 'Syncing…' : 'Sync now'}
                    </button>
                ) : (
                    <span className="text-xs text-foreground-muted px-2">offline</span>
                )}
            </div>

            {expanded && (
                <ul className="border-t border-border divide-y divide-border">
                    {items.map(item => (
                        <li key={item.localId} className="flex items-center gap-2 px-3 py-2">
                            <div className="flex-1 min-w-0">
                                <div className="flex items-baseline gap-2">
                                    <span className="text-sm text-foreground truncate">
                                        {item.payload.description}
                                    </span>
                                    <span className="text-sm font-mono text-foreground-secondary flex-shrink-0">
                                        {itemAmount(item)}
                                    </span>
                                </div>
                                <div className="text-xs text-foreground-muted">
                                    {STATUS_LABEL[item.status]}
                                    {item.status === 'failed' && item.error && (
                                        <span className="text-negative"> — {item.error}</span>
                                    )}
                                </div>
                            </div>
                            {item.status === 'failed' && (
                                <button
                                    type="button"
                                    onClick={() => onRetry(item.localId)}
                                    className="min-h-[44px] min-w-[44px] px-2 rounded-lg text-sm text-primary hover:bg-primary-light transition-colors"
                                >
                                    Retry
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => onRemove(item.localId)}
                                aria-label={`Delete queued transaction ${item.payload.description}`}
                                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg text-foreground-muted hover:text-negative hover:bg-surface-hover transition-colors"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
                                    />
                                </svg>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
