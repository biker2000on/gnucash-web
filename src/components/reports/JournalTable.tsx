'use client';

import { GeneralJournalData } from '@/lib/reports/types';
import { formatCurrency } from '@/lib/format';

interface JournalTableProps {
    data: GeneralJournalData;
}

export function JournalTable({ data }: JournalTableProps) {
    return (
        <div className="overflow-x-auto">
            <table className="w-full">
                <thead>
                    <tr className="border-b border-border-hover text-foreground-secondary text-sm uppercase tracking-wider">
                        <th className="py-3 px-4 text-left font-medium w-28">Date</th>
                        <th className="py-3 px-4 text-left font-medium">Description</th>
                        <th className="py-3 px-4 text-left font-medium w-20">Num</th>
                        <th className="py-3 px-4 text-left font-medium">Account</th>
                        <th className="py-3 px-4 text-right font-medium w-32">Debit</th>
                        <th className="py-3 px-4 text-right font-medium w-32">Credit</th>
                        <th className="py-3 px-4 text-left font-medium">Memo</th>
                    </tr>
                </thead>
                <tbody>
                    {data.entries.length === 0 ? (
                        <tr>
                            <td colSpan={7} className="py-8 text-center text-foreground-secondary">
                                No transactions found for this period.
                            </td>
                        </tr>
                    ) : (
                        data.entries.map((entry, entryIdx) => (
                            <JournalEntryRows
                                key={entry.transactionGuid}
                                entry={entry}
                                isEven={entryIdx % 2 === 0}
                            />
                        ))
                    )}
                </tbody>
                <tfoot>
                    <tr className="border-t-2 border-border-hover">
                        <td colSpan={3} className="py-3 px-4 font-semibold text-foreground">
                            Totals ({data.entryCount} {data.entryCount === 1 ? 'entry' : 'entries'})
                        </td>
                        <td></td>
                        <td className="py-3 px-4 text-right font-mono font-semibold text-emerald-400">
                            {formatCurrency(data.totalDebits, 'USD')}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-semibold text-rose-400">
                            {formatCurrency(data.totalCredits, 'USD')}
                        </td>
                        <td></td>
                    </tr>
                </tfoot>
            </table>
        </div>
    );
}

interface JournalEntryRowsProps {
    entry: GeneralJournalData['entries'][number];
    isEven: boolean;
}

function JournalEntryRows({ entry, isEven }: JournalEntryRowsProps) {
    const bgClass = isEven ? 'bg-background-secondary/20' : '';

    return (
        <>
            {/* Transaction header row */}
            <tr className={`${bgClass} border-t border-border/50`}>
                <td className="py-2 px-4 font-mono text-sm text-foreground-secondary">
                    {entry.date}
                </td>
                <td className="py-2 px-4 font-semibold text-foreground">
                    {entry.description}
                </td>
                <td className="py-2 px-4 text-sm text-foreground-secondary font-mono">
                    {entry.num}
                </td>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
            </tr>
            {/* Split rows */}
            {entry.splits.map((split, splitIdx) => (
                <tr key={splitIdx} className={`${bgClass} hover:bg-surface-hover/20 transition-colors`}>
                    <td></td>
                    <td></td>
                    <td></td>
                    <td className="py-1.5 px-4 text-sm text-foreground-secondary pl-8">
                        {split.accountPath}
                    </td>
                    <td className="py-1.5 px-4 text-right font-mono text-sm">
                        {split.debit > 0 ? (
                            <span className="text-emerald-400">{formatCurrency(split.debit, 'USD')}</span>
                        ) : null}
                    </td>
                    <td className="py-1.5 px-4 text-right font-mono text-sm">
                        {split.credit > 0 ? (
                            <span className="text-rose-400">{formatCurrency(split.credit, 'USD')}</span>
                        ) : null}
                    </td>
                    <td className="py-1.5 px-4 text-sm text-foreground-muted">
                        {split.memo}
                    </td>
                </tr>
            ))}
        </>
    );
}
