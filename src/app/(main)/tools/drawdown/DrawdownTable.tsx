'use client';

/**
 * Dense per-year projection table: withdrawals by bucket, conversions,
 * taxes, marginal bracket, RMD / IRMAA badges, and ending balances.
 * Monospace numerics per DESIGN.md.
 */

import type { DrawdownYearRow } from '@/lib/drawdown/types';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

const fmt0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function money(v: number): string {
    return v === 0 ? '—' : fmt0.format(Math.round(v));
}

function Th({ children, align = 'right' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
    return (
        <th
            className={`px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-foreground-muted whitespace-nowrap ${
                align === 'right' ? 'text-right' : 'text-left'
            }`}
        >
            {children}
        </th>
    );
}

function Td({ children, align = 'right', className = '' }: {
    children: React.ReactNode;
    align?: 'left' | 'right';
    className?: string;
}) {
    return (
        <td
            className={`px-2 py-1 font-mono text-xs whitespace-nowrap ${
                align === 'right' ? 'text-right' : 'text-left'
            } ${className}`}
            style={TNUM}
        >
            {children}
        </td>
    );
}

export default function DrawdownTable({ rows }: { rows: DrawdownYearRow[] }) {
    return (
        <div className="overflow-x-auto">
            <table className="w-full border-collapse">
                <thead>
                    <tr className="border-b border-border">
                        <Th align="left">Year</Th>
                        <Th align="left">Age</Th>
                        <Th>Spend</Th>
                        <Th>SS</Th>
                        <Th>Wd Txbl</Th>
                        <Th>Wd Trad</Th>
                        <Th>Wd Roth</Th>
                        <Th>Wd HSA</Th>
                        <Th>Convert</Th>
                        <Th>AGI</Th>
                        <Th>Fed Tax</Th>
                        <Th>State</Th>
                        <Th>Marg</Th>
                        <Th align="left">Flags</Th>
                        <Th>End Total</Th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map(row => (
                        <tr
                            key={row.year}
                            className={`border-b border-border/50 hover:bg-surface-hover transition-colors ${
                                row.shortfall > 0 ? 'bg-negative/5' : ''
                            }`}
                        >
                            <Td align="left" className="text-foreground-muted">{row.year}</Td>
                            <Td align="left" className="text-foreground">
                                {row.age}
                                {row.spouseAge !== null && (
                                    <span className="text-foreground-muted">/{row.spouseAge}</span>
                                )}
                            </Td>
                            <Td className="text-foreground-secondary">{money(row.spendingNeed)}</Td>
                            <Td className="text-foreground-secondary">{money(row.socialSecurity)}</Td>
                            <Td className="text-foreground-secondary">{money(row.withdrawals.taxable)}</Td>
                            <Td className="text-foreground-secondary">{money(row.withdrawals.traditional)}</Td>
                            <Td className="text-foreground-secondary">{money(row.withdrawals.roth)}</Td>
                            <Td className="text-foreground-secondary">{money(row.withdrawals.hsa)}</Td>
                            <Td className={row.conversion > 0 ? 'text-primary' : 'text-foreground-muted'}>
                                {money(row.conversion)}
                            </Td>
                            <Td className="text-foreground-secondary">{money(row.agi)}</Td>
                            <Td className="text-foreground-secondary">{money(row.federalTax)}</Td>
                            <Td className="text-foreground-secondary">{money(row.stateTax)}</Td>
                            <Td className="text-foreground-muted">
                                {row.marginalRate > 0 ? `${Math.round(row.marginalRate * 100)}%` : '—'}
                            </Td>
                            <Td align="left">
                                <span className="inline-flex gap-1">
                                    {row.rmd > 0 && (
                                        <span className="rounded px-1 py-0.5 text-[10px] font-semibold bg-secondary-light text-secondary">
                                            RMD
                                        </span>
                                    )}
                                    {row.irmaa && (
                                        <span
                                            className="rounded px-1 py-0.5 text-[10px] font-semibold bg-warning/10 text-warning"
                                            title={`MAGI ${row.irmaa.label} (2026 $) — est. +${fmt0.format(row.irmaa.annualSurcharge)}/yr Medicare per enrollee`}
                                        >
                                            IRMAA {row.irmaa.tier}
                                        </span>
                                    )}
                                    {row.shortfall > 0 && (
                                        <span className="rounded px-1 py-0.5 text-[10px] font-semibold bg-negative/10 text-negative">
                                            SHORT
                                        </span>
                                    )}
                                </span>
                            </Td>
                            <Td className={row.endTotal > 0 ? 'text-foreground' : 'text-negative'}>
                                {fmt0.format(Math.round(row.endTotal))}
                            </Td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
