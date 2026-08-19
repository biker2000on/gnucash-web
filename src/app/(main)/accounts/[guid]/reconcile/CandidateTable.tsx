'use client';

import { formatCurrency } from '@/lib/format';
import type { ReconcileCandidate } from '@/lib/reconcile-shared';
import { Tip } from '@/components/ui/Tooltip';

interface CandidateTableProps {
    candidates: ReconcileCandidate[];
    selected: Set<string>;
    onToggle: (index: number, shiftKey: boolean) => void;
    /** Select (true) or deselect (false) every candidate. */
    onSelectAll: (select: boolean) => void;
    onDelete: (candidate: ReconcileCandidate) => void;
    currency: string;
}

/** Badge styling matches AccountLedger's reconcile-state display. */
function stateBadge(state: 'n' | 'c') {
    return state === 'c'
        ? { icon: 'C', color: 'text-warning bg-warning/10', label: 'Cleared' }
        : { icon: 'N', color: 'text-foreground-muted bg-surface/10', label: 'Not Reconciled' };
}

/**
 * The candidate splits table: checkbox, date, num, description, funds in/out,
 * cleared-state badge. Rows are keyboard-focusable and Space toggles the
 * focused row. The header checkbox selects/deselects every candidate.
 */
export function CandidateTable({
    candidates,
    selected,
    onToggle,
    onSelectAll,
    onDelete,
    currency,
}: CandidateTableProps) {
    const allSelected =
        candidates.length > 0 && candidates.every((c) => selected.has(c.guid));

    if (candidates.length === 0) {
        return (
            <div className="border border-border rounded-lg bg-surface p-12 text-center text-foreground-secondary text-sm">
                No unreconciled transactions on or before the statement date.
            </div>
        );
    }

    return (
        <div className="border border-border rounded-lg bg-surface overflow-x-auto">
            <table className="w-full text-sm">
                <thead>
                    <tr className="border-b border-border text-xs text-foreground-muted uppercase tracking-widest">
                        <th className="p-3 w-10 text-left">
                            <input
                                type="checkbox"
                                checked={allSelected}
                                onChange={(e) => onSelectAll(e.target.checked)}
                                aria-label="Select all splits"
                                className="accent-[var(--primary)] cursor-pointer disabled:cursor-not-allowed"
                            />
                        </th>
                        <th className="p-3 text-left font-semibold">Date</th>
                        <th className="p-3 text-left font-semibold">Num</th>
                        <th className="p-3 text-left font-semibold">Description</th>
                        <th className="p-3 text-right font-semibold">Funds In</th>
                        <th className="p-3 text-right font-semibold">Funds Out</th>
                        <th className="p-3 text-center font-semibold w-14">State</th>
                        <th className="p-3 text-center font-semibold w-14">
                            <span className="sr-only">Actions</span>
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {candidates.map((c, index) => {
                        const isSelected = selected.has(c.guid);
                        const badge = stateBadge(c.state);
                        return (
                            <tr
                                key={c.guid}
                                tabIndex={0}
                                role="row"
                                aria-selected={isSelected}
                                onClick={(event) => onToggle(index, event.shiftKey)}
                                onKeyDown={(e) => {
                                    if (e.key === ' ' || e.key === 'Spacebar') {
                                        e.preventDefault();
                                        onToggle(index, e.shiftKey);
                                    }
                                }}
                                className={`border-b border-border last:border-b-0 cursor-pointer transition-colors duration-150 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--primary)] ${
                                    isSelected ? 'bg-primary-light' : 'hover:bg-surface-hover'
                                }`}
                            >
                                <td className="p-3">
                                    <input
                                        type="checkbox"
                                        checked={isSelected}
                                        readOnly
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onToggle(index, e.shiftKey);
                                        }}
                                        tabIndex={-1}
                                        aria-label={`Select ${c.description || 'split'}`}
                                        className="accent-[var(--primary)] cursor-pointer"
                                    />
                                </td>
                                <td
                                    className="p-3 font-mono text-foreground-secondary whitespace-nowrap"
                                    style={{ fontFeatureSettings: "'tnum'" }}
                                >
                                    {c.date ? c.date.slice(0, 10) : '—'}
                                </td>
                                <td className="p-3 font-mono text-foreground-muted">{c.num || ''}</td>
                                <td className="p-3 text-foreground">
                                    {c.description || <span className="text-foreground-muted">(no description)</span>}
                                    {c.memo && (
                                        <span className="block text-xs text-foreground-muted">{c.memo}</span>
                                    )}
                                </td>
                                <td
                                    className="p-3 text-right font-mono text-positive"
                                    style={{ fontFeatureSettings: "'tnum'" }}
                                >
                                    {c.amount > 0 ? formatCurrency(c.amount, currency) : ''}
                                </td>
                                <td
                                    className="p-3 text-right font-mono text-negative"
                                    style={{ fontFeatureSettings: "'tnum'" }}
                                >
                                    {c.amount < 0 ? formatCurrency(Math.abs(c.amount), currency) : ''}
                                </td>
                                <td className="p-3 text-center">
                                    <Tip content={badge.label}>
                                    <span
                                        className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-mono font-semibold ${badge.color}`}
                                    >
                                        {badge.icon}
                                    </span>
                                    </Tip>
                                </td>
                                <td className="p-2 text-center">
                                    <Tip content="Delete transaction">
                                    <button
                                        type="button"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            onDelete(c);
                                        }}
                                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground-muted hover:bg-negative/10 hover:text-negative transition-colors"
                                        aria-label={`Delete ${c.description || 'transaction'}`}
                                    >
                                        <svg
                                            className="h-4 w-4"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                            aria-hidden="true"
                                        >
                                            <path d="M3 6h18" />
                                            <path d="M8 6V4h8v2" />
                                            <path d="M19 6l-1 14H6L5 6" />
                                            <path d="M10 11v5M14 11v5" />
                                        </svg>
                                    </button>
                                    </Tip>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
