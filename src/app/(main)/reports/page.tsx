'use client';

import Link from 'next/link';
import { REPORTS, getReportsByCategory, ReportConfig } from '@/lib/reports/types';

const CATEGORY_LABELS: Record<string, string> = {
    financial: 'Financial Statements',
    account: 'Account Reports',
    transaction: 'Transaction Reports',
};

const CATEGORY_ORDER = ['financial', 'account', 'transaction'];

function ReportIcon({ icon }: { icon: string }) {
    switch (icon) {
        case 'balance':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
                </svg>
            );
        case 'trending':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
            );
        case 'cash':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
            );
        case 'account':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
            );
        case 'list':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                </svg>
            );
        default:
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
            );
    }
}

function ReportCard({ report }: { report: ReportConfig }) {
    return (
        <Link
            href={`/reports/${report.type}`}
            className="group block bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-xl p-6 hover:border-cyan-500/50 hover:bg-neutral-900/50 transition-all duration-200"
        >
            <div className="flex items-start gap-4">
                <div className="p-3 bg-gradient-to-br from-cyan-500/20 to-emerald-500/20 rounded-xl text-cyan-400 group-hover:from-cyan-500/30 group-hover:to-emerald-500/30 transition-colors">
                    <ReportIcon icon={report.icon} />
                </div>
                <div className="flex-1 min-w-0">
                    <h3 className="text-lg font-semibold text-neutral-100 group-hover:text-cyan-400 transition-colors">
                        {report.name}
                    </h3>
                    <p className="mt-1 text-sm text-neutral-500 line-clamp-2">
                        {report.description}
                    </p>
                </div>
                <div className="text-neutral-600 group-hover:text-cyan-400 transition-colors">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                </div>
            </div>
        </Link>
    );
}

export default function ReportsPage() {
    const reportsByCategory = getReportsByCategory();

    return (
        <div className="space-y-8">
            <header>
                <h1 className="text-3xl font-bold text-neutral-100">Reports</h1>
                <p className="text-neutral-500 mt-1">
                    Generate financial reports and analyze your data.
                </p>
            </header>

            {CATEGORY_ORDER.map(category => {
                const reports = reportsByCategory[category];
                if (!reports || reports.length === 0) return null;

                return (
                    <section key={category} className="space-y-4">
                        <h2 className="text-lg font-semibold text-neutral-300 uppercase tracking-wider">
                            {CATEGORY_LABELS[category] || category}
                        </h2>
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            {reports.map(report => (
                                <ReportCard key={report.type} report={report} />
                            ))}
                        </div>
                    </section>
                );
            })}
        </div>
    );
}
