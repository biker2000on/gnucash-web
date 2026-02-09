'use client';

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
        <div className="bg-surface border border-border rounded-xl p-6 animate-pulse">
            <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 bg-background-secondary rounded-lg" />
                <div className="h-4 w-24 bg-background-secondary rounded" />
            </div>
            <div className="h-7 w-32 bg-background-secondary rounded mb-2" />
            <div className="h-4 w-20 bg-background-secondary rounded" />
        </div>
    );
}

interface KPICardProps {
    icon: React.ReactNode;
    label: string;
    value: string;
    change?: React.ReactNode;
    sublabel?: string;
}

function KPICard({ icon, label, value, change, sublabel }: KPICardProps) {
    return (
        <div className="bg-surface border border-border rounded-xl p-6 transition-all hover:border-emerald-500/30">
            <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-lg bg-background-secondary flex items-center justify-center text-foreground-secondary">
                    {icon}
                </div>
                <span className="text-sm text-foreground-secondary font-medium">{label}</span>
            </div>
            <div className="text-2xl font-bold text-foreground mb-1">{value}</div>
            {change && <div>{change}</div>}
            {sublabel && <div className="text-xs text-foreground-muted mt-1">{sublabel}</div>}
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
    if (loading) {
        return (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
                {Array.from({ length: 5 }).map((_, i) => (
                    <KPICardSkeleton key={i} />
                ))}
            </div>
        );
    }

    if (!data) {
        return (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
                {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="bg-surface border border-border rounded-xl p-6">
                        <p className="text-foreground-muted text-sm text-center">No data</p>
                    </div>
                ))}
            </div>
        );
    }

    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
            <KPICard
                icon={<IconNetWorth />}
                label="Net Worth"
                value={formatCurrency(data.netWorth)}
                change={
                    <div className="flex items-center gap-2">
                        <ChangeIndicator value={data.netWorthChange} />
                        <span className="text-xs text-foreground-muted">
                            ({formatPercent(data.netWorthChangePercent)})
                        </span>
                    </div>
                }
            />
            <KPICard
                icon={<IconIncome />}
                label="Total Income"
                value={formatCurrency(data.totalIncome)}
            />
            <KPICard
                icon={<IconExpense />}
                label="Total Expenses"
                value={formatCurrency(data.totalExpenses)}
                sublabel={data.topExpenseCategory ? `Top: ${data.topExpenseCategory}` : undefined}
            />
            <KPICard
                icon={<IconSavings />}
                label="Savings Rate"
                value={`${data.savingsRate.toFixed(1)}%`}
                change={
                    <span className={`text-xs font-medium ${data.savingsRate >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {data.savingsRate >= 20 ? 'Healthy' : data.savingsRate >= 0 ? 'Low' : 'Negative'}
                    </span>
                }
            />
            <KPICard
                icon={<IconInvestment />}
                label="Investment Value"
                value={formatCurrency(data.investmentValue)}
            />
        </div>
    );
}
