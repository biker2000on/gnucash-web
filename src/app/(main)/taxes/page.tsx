'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import { DomainFeatureSections } from '@/components/hub/DomainFeatureSections';
import { formatCurrency } from '@/lib/format';

interface WithholdingCheckupSummary {
    hasData: boolean;
    projectedLiability: number;
    projectedTotalPayments: number;
    projectedBalance: number;
    status: 'refund' | 'owe' | 'balanced';
}

type LoadState = 'loading' | 'ready' | 'setup';

export default function TaxesHubPage() {
    const [state, setState] = useState<LoadState>('loading');
    const [checkup, setCheckup] = useState<WithholdingCheckupSummary | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetch('/api/tools/withholding')
            .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
            .then((data: { checkup?: WithholdingCheckupSummary }) => {
                if (cancelled) return;
                if (data.checkup?.hasData) {
                    setCheckup(data.checkup);
                    setState('ready');
                } else {
                    setState('setup');
                }
            })
            .catch(() => {
                if (!cancelled) setState('setup');
            });
        return () => {
            cancelled = true;
        };
    }, []);

    return (
        <div className="space-y-6">
            <PageHeader
                title="Taxes"
                subtitle="Plan ahead during the year, then file with numbers straight from your book."
            />

            {state === 'loading' && (
                <StatGrid cols={3}>
                    {[1, 2, 3].map(i => (
                        <div
                            key={i}
                            className="bg-surface/30 border border-border rounded-lg px-3 py-2 sm:rounded-xl sm:p-5 animate-pulse"
                        >
                            <div className="h-3 bg-foreground-muted/20 rounded w-24 mb-2" />
                            <div className="h-5 sm:h-7 bg-foreground-muted/20 rounded w-28" />
                        </div>
                    ))}
                </StatGrid>
            )}

            {state === 'ready' && checkup && (
                <StatGrid cols={3}>
                    <StatCard
                        label="Projected Liability"
                        value={formatCurrency(checkup.projectedLiability)}
                        sub="Federal, this tax year"
                    />
                    <StatCard
                        label="Projected Payments"
                        value={formatCurrency(checkup.projectedTotalPayments)}
                        sub="Withholding + estimates"
                    />
                    <StatCard
                        label={checkup.status === 'owe' ? 'Projected Owed' : 'Projected Refund'}
                        value={formatCurrency(Math.abs(checkup.projectedBalance))}
                        tone={
                            checkup.status === 'owe'
                                ? 'negative'
                                : checkup.status === 'refund'
                                    ? 'positive'
                                    : 'default'
                        }
                        sub={checkup.status === 'balanced' ? 'On track' : 'At year end'}
                    />
                </StatGrid>
            )}

            {state === 'setup' && (
                <div className="border border-border bg-surface/30 rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-foreground-secondary">
                        No withholding projection yet — run the checkup to see your projected
                        year-end liability here.
                    </p>
                    <Link
                        href="/tools/withholding"
                        className="shrink-0 px-3 py-1.5 text-sm rounded-md border border-border text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors duration-150"
                    >
                        Set up
                    </Link>
                </div>
            )}

            <DomainFeatureSections domain="taxes" />
        </div>
    );
}
