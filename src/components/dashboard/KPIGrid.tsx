'use client';

import { useState } from 'react';
import { ProvenanceModal } from '@/components/provenance/ProvenanceModal';

interface TraceReference {
    traceId: string;
    href: string;
}

interface KPIData {
    netWorth: number;
    netWorthChange: number;
    netWorthChangePercent: number;
    totalIncome: number;
    totalExpenses: number;
    savingsRate: number;
    topExpenseCategory: string;
    topExpenseAmount: number;
    investmentValue: number;
    traces?: Partial<Record<'netWorth' | 'totalIncome' | 'totalExpenses' | 'savingsRate' | 'investmentValue', TraceReference>>;
}

interface KPIGridProps {
    data: KPIData | null;
    loading: boolean;
}

function formatCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
    }).format(value);
}

function formatPercent(value: number): string {
    return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function ChangeIndicator({ value, suffix = '' }: { value: number; suffix?: string }) {
    if (value === 0) return null;
    const isPositive = value > 0;
    return (
        <span className={`flex items-center gap-1 text-xs font-medium ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                {isPositive ? (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                )}
            </svg>
            {suffix ? `${Math.abs(value).toFixed(1)}${suffix}` : formatCurrency(Math.abs(value))}
        </span>
    );
}

function KPICardSkeleton() {
    return (
        <div className="bg-surface border border-border rounded-xl p-4 sm:p-6 animate-pulse">
            <div className="flex items-center gap-3 sm:mb-4">
                <div className="w-10 h-10 bg-background-secondary rounded-lg flex-shrink-0" />
                <div className="sm:hidden flex-1">
                    <div className="h-3 w-16 bg-background-secondary rounded mb-1" />
                    <div className="h-5 w-24 bg-background-secondary rounded" />
                </div>
                <div className="hidden sm:block h-4 w-24 bg-background-secondary rounded" />
            </div>
            <div className="hidden sm:block h-7 w-32 bg-background-secondary rounded mb-2" />
            <div className="hidden sm:block h-4 w-20 bg-background-secondary rounded" />
        </div>
    );
}

interface KPICardProps {
    icon: React.ReactNode;
    label: string;
    value: string;
    change?: React.ReactNode;
    sublabel?: string;
    traceId?: string;
    onExplain?: (traceId: string) => void;
}

function ExplainButton({
    traceId,
    onExplain,
}: {
    traceId?: string;
    onExplain?: (traceId: string) => void;
}) {
    if (!traceId || !onExplain) return null;
    return (
        <button
            type="button"
            onClick={() => onExplain(traceId)}
            className="text-[11px] font-medium text-primary hover:text-primary-hover"
            aria-label="Explain this number"
        >
            Explain
        </button>
    );
}

function KPICard({ icon, label, value, change, sublabel, traceId, onExplain }: KPICardProps) {
    return (
        <div className="bg-surface border border-border rounded-xl p-4 sm:p-6 transition-all hover:border-primary/30">
            <div className="flex items-center gap-3 sm:mb-4">
                <div className="w-10 h-10 rounded-lg bg-background-secondary flex items-center justify-center text-foreground-secondary flex-shrink-0">
                    {icon}
                </div>
                <div className="sm:hidden flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                        <div className="text-xs text-foreground-secondary font-medium">{label}</div>
                        <div className="text-sm font-bold text-foreground">{value}</div>
                    </div>
                    {(change || sublabel) && (
                        <div className="flex items-center gap-2 justify-end">
                            {change && <div>{change}</div>}
                            {sublabel && <div className="text-xs text-foreground-muted">{sublabel}</div>}
                        </div>
                    )}
                </div>
                <span className="hidden sm:inline text-sm text-foreground-secondary font-medium flex-1">{label}</span>
                <span className="hidden sm:inline">
                    <ExplainButton traceId={traceId} onExplain={onExplain} />
                </span>
            </div>
            <div className="hidden sm:block text-2xl font-bold text-foreground mb-1">{value}</div>
            {change && <div className="hidden sm:block">{change}</div>}
            {sublabel && <div className="hidden sm:block text-xs text-foreground-muted mt-1">{sublabel}</div>}
        </div>
    );
}

// Icon components
function IconNetWorth() {
    return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2 20h20M5 20V10l7-7 7 7v10" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 20v-4a3 3 0 016 0v4" />
        </svg>
    );
}

function IconIncome() {
    return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M22 7l-7 7-4-4-8 8" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 7h6v6" />
        </svg>
    );
}

function IconExpense() {
    return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M22 17l-7-7-4 4-8-8" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 17h6v-6" />
        </svg>
    );
}

function IconSavings() {
    return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 10c0-1.5-.5-3-2-4M10 4.5C7 4.5 4 7 4 10.5c0 2 .5 3 1.5 4L5 18h3l.5-1h7l.5 1h3l-.5-3.5c1-.5 2-2 2-4.5 0-1-.5-3-2-4" />
            <circle cx="14" cy="10" r="1" fill="currentColor" stroke="none" />
            <path strokeLinecap="round" d="M10 4.5C10 3.12 11.12 2 12.5 2S15 3.12 15 4.5" />
        </svg>
    );
}

function IconInvestment() {
    return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" d="M3 3v18h18" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M7 16v-3M11 16V9M15 16v-5M19 16V7" />
        </svg>
    );
}

export default function KPIGrid({ data, loading }: KPIGridProps) {
    const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
    if (loading) {
        return (
            <>
                <div className="sm:hidden bg-surface border border-border rounded-xl divide-y divide-border/40 animate-pulse">
                    {Array.from({ length: 5 }).map((_, i) => (
                        <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                            <div className="w-8 h-8 bg-background-secondary rounded-lg shrink-0" />
                            <div className="h-3 w-24 bg-background-secondary rounded" />
                            <div className="h-4 w-20 bg-background-secondary rounded ml-auto" />
                        </div>
                    ))}
                </div>
                <div className="hidden sm:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
                    {Array.from({ length: 5 }).map((_, i) => (
                        <KPICardSkeleton key={i} />
                    ))}
                </div>
            </>
        );
    }

    if (!data) {
        return (
            <>
                <div className="sm:hidden bg-surface border border-border rounded-xl p-6">
                    <p className="text-foreground-muted text-sm text-center">No data</p>
                </div>
                <div className="hidden sm:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
                    {Array.from({ length: 5 }).map((_, i) => (
                        <div key={i} className="bg-surface border border-border rounded-xl p-6">
                            <p className="text-foreground-muted text-sm text-center">No data</p>
                        </div>
                    ))}
                </div>
            </>
        );
    }

    const cards: KPICardProps[] = [
        {
            icon: <IconNetWorth />,
            label: 'Net Worth',
            value: formatCurrency(data.netWorth),
            change: (
                <div className="flex items-center gap-2">
                    <ChangeIndicator value={data.netWorthChange} />
                    <span className="text-xs text-foreground-muted">
                        ({formatPercent(data.netWorthChangePercent)})
                    </span>
                </div>
            ),
            traceId: data.traces?.netWorth?.traceId,
            onExplain: setSelectedTraceId,
        },
        {
            icon: <IconIncome />,
            label: 'Total Income',
            value: formatCurrency(data.totalIncome),
            traceId: data.traces?.totalIncome?.traceId,
            onExplain: setSelectedTraceId,
        },
        {
            icon: <IconExpense />,
            label: 'Total Expenses',
            value: formatCurrency(data.totalExpenses),
            sublabel: data.topExpenseCategory ? `Top: ${data.topExpenseCategory}` : undefined,
            traceId: data.traces?.totalExpenses?.traceId,
            onExplain: setSelectedTraceId,
        },
        {
            icon: <IconSavings />,
            label: 'Savings Rate',
            value: `${data.savingsRate.toFixed(1)}%`,
            change: (
                <span className={`text-xs font-medium ${data.savingsRate >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {data.savingsRate >= 20 ? 'Healthy' : data.savingsRate >= 0 ? 'Low' : 'Negative'}
                </span>
            ),
            traceId: data.traces?.savingsRate?.traceId,
            onExplain: setSelectedTraceId,
        },
        {
            icon: <IconInvestment />,
            label: 'Investment Value',
            value: formatCurrency(data.investmentValue),
            traceId: data.traces?.investmentValue?.traceId,
            onExplain: setSelectedTraceId,
        },
    ];

    return (
        <>
            {/* Phone: one condensed card with a row per KPI */}
            <div className="sm:hidden bg-surface border border-border rounded-xl divide-y divide-border/40">
                {cards.map(card => (
                    <div key={card.label} className="flex items-center gap-3 px-4 py-2.5">
                        <div className="w-8 h-8 rounded-lg bg-background-secondary flex items-center justify-center text-foreground-secondary shrink-0">
                            {card.icon}
                        </div>
                        <div className="text-xs text-foreground-secondary font-medium flex-1 min-w-0 truncate">
                            {card.label}
                        </div>
                        <div className="text-right min-w-0">
                            <div className="text-sm font-bold text-foreground font-mono" style={{ fontFeatureSettings: "'tnum'" }}>
                                {card.value}
                            </div>
                            {(card.change || card.sublabel) && (
                                <div className="flex items-center gap-2 justify-end">
                                    {card.change}
                                    {card.sublabel && (
                                        <span className="text-[11px] text-foreground-muted truncate max-w-36">{card.sublabel}</span>
                                    )}
                                </div>
                            )}
                            <ExplainButton traceId={card.traceId} onExplain={card.onExplain} />
                        </div>
                    </div>
                ))}
            </div>

            {/* Tablet/desktop: card grid */}
            <div className="hidden sm:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
                {cards.map(card => (
                    <KPICard key={card.label} {...card} />
                ))}
            </div>
            <ProvenanceModal
                traceId={selectedTraceId}
                isOpen={selectedTraceId !== null}
                onClose={() => setSelectedTraceId(null)}
            />
        </>
    );
}
