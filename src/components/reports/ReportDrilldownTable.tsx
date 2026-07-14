'use client';

import { useMemo, useState } from 'react';
import { TransactionDrilldownModal, DrilldownTarget } from './TransactionDrilldownModal';

/**
 * Reusable report drill-down table.
 *
 * Renders a report's per-account detail rows grouped into labelled sections
 * (e.g. Income / Spending, Gains / Losses), with sortable columns and an
 * account-name column that opens the shared TransactionDrilldownModal for the
 * report's date range. Drop this in wherever a report lists accounts against a
 * signed amount so every such report gets consistent grouping + drill-down.
 */

export interface DrilldownColumn<T> {
    header: string;
    align?: 'left' | 'right';
    render: (row: T) => React.ReactNode;
    /** Providing this makes the column sortable. */
    sortValue?: (row: T) => number | string;
}

export interface DrilldownGroup<T> {
    key: string;
    label: string;
    rows: T[];
}

export interface ReportDrilldownTableProps<T> {
    title: string;
    /** Header for the first (account) column. Defaults to "Account". */
    nameHeader?: string;
    /** Columns rendered after the account column. */
    columns: DrilldownColumn<T>[];
    /** Pre-grouped rows; empty groups are skipped. */
    groups: DrilldownGroup<T>[];
    /** Account identity per row; a null guid renders as plain (non-clickable) text. */
    getAccount: (row: T) => { guid: string | null; name: string };
    /** Report date range used for the drill-down query. */
    dateRange: { startDate: string; endDate: string };
    emptyText: string;
}

// null column index => the account/name column.
type SortState = { col: number | null; direction: 'asc' | 'desc' | null };

function SortIcon({ direction }: { direction: 'asc' | 'desc' | null }) {
    if (direction === 'asc') {
        return (
            <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3 inline-block" fill="none">
                <path d="M8 3v10M8 3 4.5 6.5M8 3l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        );
    }
    if (direction === 'desc') {
        return (
            <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3 inline-block" fill="none">
                <path d="M8 13V3M8 13l3.5-3.5M8 13 4.5 9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        );
    }
    return (
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3 inline-block opacity-40" fill="none">
            <path d="M5.5 3 3 5.5 5.5 8M3 5.5h10M10.5 8 13 10.5 10.5 13M13 10.5H3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export function ReportDrilldownTable<T>({
    title,
    nameHeader = 'Account',
    columns,
    groups,
    getAccount,
    dateRange,
    emptyText,
}: ReportDrilldownTableProps<T>) {
    const [sort, setSort] = useState<SortState>({ col: null, direction: null });
    const [drilldown, setDrilldown] = useState<DrilldownTarget | null>(null);

    const nonEmptyGroups = groups.filter(g => g.rows.length > 0);

    const sortValueFor = (row: T, col: number | null): number | string => {
        if (col === null) return getAccount(row).name;
        return columns[col].sortValue?.(row) ?? '';
    };

    const sortedGroups = useMemo(() => {
        if (sort.col === null && sort.direction === null) return nonEmptyGroups;
        if (!sort.direction) return nonEmptyGroups;
        const mult = sort.direction === 'asc' ? 1 : -1;
        return nonEmptyGroups.map(g => ({
            ...g,
            rows: [...g.rows].sort((a, b) => {
                const va = sortValueFor(a, sort.col);
                const vb = sortValueFor(b, sort.col);
                if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mult;
                return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * mult;
            }),
        }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nonEmptyGroups, sort]);

    const toggleSort = (col: number | null) => {
        setSort(prev => {
            const same = prev.col === col;
            if (!same) return { col, direction: 'asc' };
            if (prev.direction === 'asc') return { col, direction: 'desc' };
            return { col: null, direction: null };
        });
    };

    const colSpan = 1 + columns.length;
    const rangeLabel = `${dateRange.startDate} → ${dateRange.endDate}`;

    const headerButton = (label: string, col: number | null, align: 'left' | 'right', sortable: boolean) => {
        const active = sort.col === col;
        const direction = active ? sort.direction : null;
        const base = `inline-flex items-center gap-1 ${align === 'right' ? 'justify-end w-full' : ''} ${active ? 'text-primary' : ''}`;
        if (!sortable) return <span>{label}</span>;
        return (
            <button
                type="button"
                onClick={() => toggleSort(col)}
                aria-label={`Sort by ${label}`}
                className={`${base} hover:text-foreground focus:outline-none focus:text-primary`}
            >
                <span>{label}</span>
                <SortIcon direction={direction} />
            </button>
        );
    };

    return (
        <div className="border-t border-border">
            <h3 className="px-4 pt-4 pb-2 text-sm font-semibold text-foreground">{title}</h3>
            {nonEmptyGroups.length === 0 ? (
                <p className="px-4 pb-4 text-sm text-foreground-muted">{emptyText}</p>
            ) : (
                <div className="overflow-x-auto pb-2">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-border bg-background-tertiary/50">
                                <th className="px-4 py-2 text-left text-xs uppercase tracking-wider text-foreground-muted font-medium">
                                    {headerButton(nameHeader, null, 'left', true)}
                                </th>
                                {columns.map((c, i) => (
                                    <th
                                        key={c.header}
                                        className={`px-4 py-2 text-xs uppercase tracking-wider text-foreground-muted font-medium ${c.align === 'left' ? 'text-left' : 'text-right'}`}
                                    >
                                        {headerButton(c.header, i, c.align ?? 'right', !!c.sortValue)}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {sortedGroups.map(group => (
                                <GroupSection
                                    key={group.key}
                                    group={group}
                                    columns={columns}
                                    getAccount={getAccount}
                                    colSpan={colSpan}
                                    showGroupHeader={sortedGroups.length > 1}
                                    onDrill={(guid, name) =>
                                        setDrilldown({
                                            accountGuid: guid,
                                            accountName: name,
                                            periodLabel: rangeLabel,
                                            startDate: dateRange.startDate,
                                            endDate: dateRange.endDate,
                                        })
                                    }
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <TransactionDrilldownModal target={drilldown} onClose={() => setDrilldown(null)} />
        </div>
    );
}

function GroupSection<T>({
    group,
    columns,
    getAccount,
    colSpan,
    showGroupHeader,
    onDrill,
}: {
    group: DrilldownGroup<T>;
    columns: DrilldownColumn<T>[];
    getAccount: (row: T) => { guid: string | null; name: string };
    colSpan: number;
    showGroupHeader: boolean;
    onDrill: (guid: string, name: string) => void;
}) {
    return (
        <>
            {showGroupHeader && (
                <tr className="bg-background-tertiary/30">
                    <td
                        colSpan={colSpan}
                        className="px-4 py-1.5 text-[11px] uppercase tracking-wider text-foreground-secondary font-bold border-b border-border/50"
                    >
                        {group.label}
                    </td>
                </tr>
            )}
            {group.rows.map((row, ri) => {
                const account = getAccount(row);
                return (
                    <tr key={`${group.key}-${ri}`} className="border-b border-border/50 hover:bg-surface-hover/20">
                        <td className="px-4 py-1.5 text-foreground">
                            {account.guid ? (
                                <button
                                    type="button"
                                    onClick={() => onDrill(account.guid!, account.name)}
                                    className="text-left hover:underline text-primary focus:outline-none focus:underline"
                                >
                                    {account.name}
                                </button>
                            ) : (
                                account.name
                            )}
                        </td>
                        {columns.map((c, ci) => (
                            <td
                                key={ci}
                                className={`px-4 py-1.5 font-mono tabular-nums ${c.align === 'left' ? 'text-left' : 'text-right'}`}
                            >
                                {c.render(row)}
                            </td>
                        ))}
                    </tr>
                );
            })}
        </>
    );
}
