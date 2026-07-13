'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import { DomainFeatureSections } from '@/components/hub/DomainFeatureSections';
import { formatCurrency } from '@/lib/format';

interface Kpis {
    netWorth: number;
    totalIncome: number;
    totalExpenses: number;
    savingsRate: number;
}

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

function StatSkeleton() {
    return (
        <div className="bg-surface/30 border border-border rounded-lg px-3 py-2 sm:rounded-xl sm:p-5 animate-pulse">
            <div className="h-3 bg-foreground-muted/20 rounded w-20 mb-2" />
            <div className="h-5 sm:h-7 bg-foreground-muted/20 rounded w-28" />
        </div>
    );
}

export default function MoneyHubPage() {
    const [kpis, setKpis] = useState<Kpis | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const now = new Date();
        const start = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`;
        const end = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
        fetch(`/api/dashboard/kpis?startDate=${start}&endDate=${end}`)
            .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
            .then((data: Kpis) => {
                if (!cancelled) setKpis(data);
            })
            .catch(() => {
                if (!cancelled) setFailed(true);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const cashFlow = kpis ? kpis.totalIncome - kpis.totalExpenses : 0;

    return (
        <div className="space-y-6">
            <PageHeader
                title="Money"
                subtitle="Everyday accounting — accounts, ledgers, documents, and imports."
            />

            {failed ? (
                <StatGrid cols={4}>
                    <StatSkeleton />
                    <StatSkeleton />
                    <StatSkeleton />
                    <StatSkeleton />
                </StatGrid>
            ) : (
                <StatGrid cols={4}>
                    {kpis ? (
                        <>
                            <StatCard label="Net Worth" value={formatCurrency(kpis.netWorth)} />
                            <StatCard
                                label="Cash Flow (this month)"
                                value={formatCurrency(cashFlow)}
                                tone={cashFlow >= 0 ? 'positive' : 'negative'}
                            />
                            <StatCard
                                label="Income (this month)"
                                value={formatCurrency(kpis.totalIncome)}
                            />
                            <StatCard
                                label="Expenses (this month)"
                                value={formatCurrency(kpis.totalExpenses)}
                            />
                        </>
                    ) : (
                        <>
                            <StatSkeleton />
                            <StatSkeleton />
                            <StatSkeleton />
                            <StatSkeleton />
                        </>
                    )}
                </StatGrid>
            )}

            <DomainFeatureSections domain="money" />
        </div>
    );
}
