'use client';

import type { QueryRow } from './types';

const MAX_DISPLAY_ROWS = 50;

function isNumericValue(v: unknown): boolean {
    if (typeof v === 'number') return true;
    return typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim());
}

function formatCell(v: unknown): string {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

/** Compact monospace result table for tabular query output. */
export default function ResultTable({ rows }: { rows: QueryRow[] }) {
    if (rows.length === 0) return null;

    const columns = Object.keys(rows[0]);
    if (columns.length === 0) return null;

    const display = rows.slice(0, MAX_DISPLAY_ROWS);
    // A column is right-aligned when every non-null value in it is numeric.
    const numericCols = new Set(
        columns.filter(col =>
            display.some(r => r[col] !== null && r[col] !== undefined) &&
            display.every(r => r[col] === null || r[col] === undefined || isNumericValue(r[col]))
        )
    );

    return (
        <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs font-mono [font-feature-settings:'tnum']">
                <thead>
                    <tr className="bg-background-tertiary text-foreground-secondary">
                        {columns.map(col => (
                            <th
                                key={col}
                                className={`px-3 py-1.5 font-medium whitespace-nowrap ${numericCols.has(col) ? 'text-right' : 'text-left'}`}
                            >
                                {col}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {display.map((row, i) => (
                        <tr key={i} className="border-t border-border text-foreground">
                            {columns.map(col => (
                                <td
                                    key={col}
                                    className={`px-3 py-1.5 whitespace-nowrap ${numericCols.has(col) ? 'text-right' : 'text-left'}`}
                                >
                                    {formatCell(row[col])}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
            {rows.length > MAX_DISPLAY_ROWS && (
                <p className="px-3 py-1.5 text-xs text-foreground-muted border-t border-border">
                    Showing first {MAX_DISPLAY_ROWS} of {rows.length} rows
                </p>
            )}
        </div>
    );
}
