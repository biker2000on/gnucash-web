'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { HouseholdBookBanner } from '@/components/business/HouseholdBookBanner';
import type { AccountantExportType } from '@/lib/reports/accountant-exports';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;
const inputClass = 'bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50 transition-all font-mono';

interface ExportCard {
    type: AccountantExportType;
    title: string;
    description: string;
    /** Trial balance is an as-of snapshot; the others cover the period. */
    usesStartDate: boolean;
}

const EXPORT_CARDS: ExportCard[] = [
    {
        type: 'trial_balance',
        title: 'Trial Balance',
        description: 'Every account with its debit or credit balance as of the end date. The first thing most accountants ask for — totals always balance.',
        usesStartDate: false,
    },
    {
        type: 'general_ledger',
        title: 'General Ledger',
        description: 'Per-account transaction listings for the period: opening balance, each entry with a running balance, and the closing balance.',
        usesStartDate: true,
    },
    {
        type: 'journal',
        title: 'Journal',
        description: 'Every transaction in date order with all of its splits — the complete double-entry record for the period.',
        usesStartDate: true,
    },
];

export default function AccountantWorkspacePage() {
    const year = new Date().getFullYear();
    const [startDate, setStartDate] = useState(`${year}-01-01`);
    const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));

    const downloadUrl = (type: AccountantExportType) => {
        const params = new URLSearchParams({ type, endDate });
        if (startDate) params.set('startDate', startDate);
        return `/api/business/reports/accountant?${params}`;
    };

    return (
        <div className="space-y-4">
            <PageHeader
                title="Accountant Workspace"
                subtitle="Everything your accountant asks for — trial balance, GL detail, and the journal as CSV exports."
                toolbar={
                    <div className="flex flex-wrap items-end gap-3">
                        <div>
                            <label className="block text-xs font-medium text-foreground-secondary mb-1">From</label>
                            <input
                                type="date"
                                value={startDate}
                                onChange={(e) => setStartDate(e.target.value)}
                                className={inputClass}
                                style={TNUM}
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-foreground-secondary mb-1">To</label>
                            <input
                                type="date"
                                value={endDate}
                                onChange={(e) => setEndDate(e.target.value)}
                                className={inputClass}
                                style={TNUM}
                            />
                        </div>
                    </div>
                }
            />

            <HouseholdBookBanner />

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                {EXPORT_CARDS.map((card) => (
                    <div key={card.type} className="flex flex-col bg-surface border border-border rounded-lg p-4">
                        <h2 className="text-sm font-semibold text-foreground">{card.title}</h2>
                        <p className="mt-1 flex-1 text-[13px] leading-relaxed text-foreground-secondary">
                            {card.description}
                        </p>
                        <p className="mt-2 font-mono text-xs text-foreground-muted" style={TNUM}>
                            {card.usesStartDate ? `${startDate || '(start)'} → ${endDate}` : `As of ${endDate}`}
                        </p>
                        <a
                            href={downloadUrl(card.type)}
                            download
                            className="mt-3 inline-block rounded-lg bg-primary px-4 py-2 text-center text-sm text-primary-foreground transition-colors hover:bg-primary-hover"
                        >
                            Download CSV
                        </a>
                    </div>
                ))}
            </div>

            <div className="bg-surface border border-border rounded-lg p-4">
                <h2 className="text-sm font-semibold text-foreground">Year-end tax package</h2>
                <p className="mt-1 text-[13px] text-foreground-secondary">
                    The full year-end bundle — P&L, balance sheet, and supporting schedules — lives in the tax package report.
                </p>
                <Link
                    href="/reports/tax-package"
                    className="mt-2 inline-block text-sm text-primary transition-colors hover:text-primary-hover"
                >
                    Open the tax package →
                </Link>
            </div>

            <div className="rounded-lg border border-border bg-background-secondary/50 p-4">
                <h2 className="text-sm font-semibold text-foreground">Working with an accountant?</h2>
                <p className="mt-1 text-[13px] text-foreground-secondary">
                    Instead of emailing files back and forth, invite your accountant as a{' '}
                    <span className="text-foreground">read-only user</span> — they can pull these exports
                    (and every report) themselves without being able to change anything.
                </p>
                <Link
                    href="/settings/users"
                    className="mt-2 inline-block text-sm text-primary transition-colors hover:text-primary-hover"
                >
                    Invite a read-only user →
                </Link>
            </div>
        </div>
    );
}
