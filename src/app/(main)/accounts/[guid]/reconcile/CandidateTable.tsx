'use client';

import { formatCurrency } from '@/lib/format';
import type { ReconcileCandidate } from '@/lib/reconcile-shared';

interface CandidateTableProps {
    candidates: ReconcileCandidate[];
    selected: Set<string>;
    onToggle: (guid: string) => void;
    /** Select (true) or deselect (false) every cleared ('c') candidate. */
    onSelectAllCleared: (select: boolean) => void;
    currency: string;
}

/** Badge styling matches AccountLedger's reconcile-state display. */
function stateBadge(state: 'n' | 'c') {
    return state === 'c'
        ? { icon: 'C', color: 'text-amber-400 bg-amber-500/10', label: 'Cleared' }
        : { icon: 'N', color: 'text-foreground-muted bg-surface/10', label: 'Not Reconciled' };
}

/**
 * The candidate splits table: checkbox, date, num, description, funds in/out,
 * cleared-state badge. Rows are keyboard-focusable and Space toggles the
 * focused row. The header checkbox selects/deselects all cleared splits.
 */
export function CandidateTable({
    candidates,
    selected,
    onToggle,
    onSelectAllCleared,
    currency,
}: CandidateTableProps) {
    const cleared = candidates.filter((c) => c.state === 'c');
    const allClearedSelected =
        cleared.length > 0 && cleared.every((c) => selected.has(c.guid));

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
                                checked={allClearedSelected}
                                disabled={cleared.length === 0}
                                onChange={(e) => onSelectAllCleared(e.target.checked)}
                                title="Select all cleared"
                                aria-label="Select all cleared splits"
                                className="accent-[var(--primary)] cursor-pointer disabled:cursor-not-allowed"
                            />
                        </th>
                        <th className="p-3 text-left font-semibold">Date</th>
                        <th className="p-3 text-left font-semibold">Num</th>
                        <th className="p-3 text-left font-semibold">Description</th>
                        <th className="p-3 text-right font-semibold">Funds In</th>
                        <th className="p-3 text-right font-semibold">Funds Out</th>
                        <th className="p-3 text-center font-semibold w-14">State</th>
                    </tr>
                </thead>
                <tbody>
                    {candidates.map((c) => {
                        const isSelected = selected.has(c.guid);
                        const badge = stateBadge(c.state);
                        return (
                            <tr
                                key={c.guid}
                                tabIndex={0}
                                role="row"
                                aria-selected={isSelected}
                                onClick={() => onToggle(c.guid)}
                                onKeyDown={(e) => {
                                    if (e.key === ' ' || e.key === 'Spacebar') {
                                        e.preventDefault();
                                        onToggle(c.guid);
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
                                        onChange={() => onToggle(c.guid)}
                                        onClick={(e) => e.stopPropagation()}
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
                                    <span
                                        className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-mono font-semibold ${badge.color}`}
                                        title={badge.label}
                                    >
                                        {badge.icon}
                                    </span>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
