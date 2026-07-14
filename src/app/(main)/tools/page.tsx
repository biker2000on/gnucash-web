'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { FEATURES } from '@/lib/feature-registry';

// Hrefs of personal-finance tools (FIRE, withholding, …) that are hidden
// when the active book is a business/nonprofit.
const PERSONAL_ONLY_HREFS = new Set(FEATURES.filter(f => f.personalOnly).map(f => f.href));

function ToolIcon({ icon }: { icon: string }) {
    switch (icon) {
        case 'flame':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.879 16.121A3 3 0 1012.015 11L11 14H9c0 .768.293 1.536.879 2.121z" />
                </svg>
            );
        case 'house':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                </svg>
            );
        case 'calendar':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    <circle cx="12" cy="14" r="2" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} />
                </svg>
            );
        case 'percent':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 5L5 19" />
                    <circle cx="7.5" cy="7.5" r="2.5" strokeWidth={1.5} />
                    <circle cx="16.5" cy="16.5" r="2.5" strokeWidth={1.5} />
                </svg>
            );
        case 'building':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4M9 9v.01M9 12v.01M9 15v.01M9 18v.01" />
                </svg>
            );
        case 'chat':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
            );
        case 'trend':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3v14a2 2 0 002 2h16" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 14l4-4 3 3 5-6" />
                </svg>
            );
        case 'repeat':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h5M20 20v-5h-5" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4.582 9a8 8 0 0113.836-2.804L20 7.5M19.418 15a8 8 0 01-13.836 2.804L4 16.5" />
                </svg>
            );
        case 'creditcard':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <rect x="3" y="5" width="18" height="14" rx="2" strokeWidth={1.5} />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M7 15h4" />
                </svg>
            );
        case 'shield':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 3l7 3v5c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6l7-3z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.5 12l1.75 1.75L15 10" />
                </svg>
            );
        case 'digest':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <rect x="4" y="3" width="16" height="18" rx="2" strokeWidth={1.5} />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 8h8M8 12h8M8 16h5" />
                </svg>
            );
        case 'gauge':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 19a8 8 0 1116 0" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 19l4-6" />
                </svg>
            );
        case 'sliders':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h9M17 18h3" />
                    <circle cx="15" cy="6" r="2" strokeWidth={1.5} />
                    <circle cx="9" cy="12" r="2" strokeWidth={1.5} />
                    <circle cx="15" cy="18" r="2" strokeWidth={1.5} />
                </svg>
            );
        case 'heartbeat':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12h4l2-5 3 10 2-5h7" />
                </svg>
            );
        default:
            return null;
    }
}

interface ToolCardProps {
    title: string;
    description: string;
    icon: string;
    href: string;
}

function ToolCard({ title, description, icon, href }: ToolCardProps) {
    return (
        <Link
            href={href}
            className="group block bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6 hover:border-primary/50 hover:bg-surface/50 transition-all duration-200"
        >
            <div className="flex items-start gap-4">
                <div className="p-3 bg-primary/20 rounded-xl text-primary group-hover:bg-primary/30 transition-colors">
                    <ToolIcon icon={icon} />
                </div>
                <div className="flex-1 min-w-0">
                    <h3 className="text-lg font-semibold text-foreground group-hover:text-primary transition-colors">
                        {title}
                    </h3>
                    <p className="mt-1 text-sm text-foreground-muted line-clamp-2">
                        {description}
                    </p>
                </div>
                <div className="text-foreground-muted group-hover:text-primary transition-colors">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                </div>
            </div>
        </Link>
    );
}

export default function ToolsPage() {
    // Business/nonprofit books hide the personal-only tools.
    const [isBusinessBook, setIsBusinessBook] = useState(false);
    useEffect(() => {
        let cancelled = false;
        fetch('/api/entity')
            .then(res => (res.ok ? res.json() : null))
            .then(profile => {
                if (!cancelled && profile?.entityType) {
                    setIsBusinessBook(profile.entityType !== 'household');
                }
            })
            .catch(() => { /* show everything on failure */ });
        return () => { cancelled = true; };
    }, []);

    const tools = [
        {
            title: 'Cash Flow Forecast',
            description: 'Project cash account balances forward using scheduled transactions and your historical spending rate, with low-balance warnings.',
            icon: 'trend',
            href: '/tools/cash-flow-forecast',
        },
        {
            title: 'Subscriptions',
            description: 'Detect recurring charges and subscriptions from your spending, with price-increase tracking and monthly/annual cost totals.',
            icon: 'repeat',
            href: '/tools/subscriptions',
        },
        {
            title: 'Spending Watch',
            description: 'Spot spending anomalies and possible fraud — duplicate charges, unfamiliar merchants, unusually large charges, and category spikes — with one-click scan-and-alert.',
            icon: 'shield',
            href: '/tools/anomalies',
        },
        {
            title: 'Debt Payoff',
            description: 'Compare snowball vs avalanche payoff strategies across your debts and see how extra payments move your debt-free date.',
            icon: 'creditcard',
            href: '/tools/debt-payoff',
        },
        {
            title: 'Monthly Digest',
            description: 'A month-at-a-glance summary — net-worth change, cash flow, top categories with deltas, subscription changes, upcoming bills, and budget status.',
            icon: 'digest',
            href: '/tools/digest',
        },
        {
            title: 'Withholding Checkup',
            description: 'Project your year-end federal tax from year-to-date data, see whether you are under-withheld, and get safe-harbor estimates plus a per-paycheck adjustment.',
            icon: 'gauge',
            href: '/tools/withholding',
        },
        {
            title: 'Data Health',
            description: 'Check your book for unbalanced transactions, orphaned splits, stale or missing prices, and unreconciled aging — with a health score and fix links.',
            icon: 'heartbeat',
            href: '/tools/data-health',
        },
        {
            title: 'FIRE Calculator',
            description: 'Calculate your Financial Independence number and estimate years to retirement.',
            icon: 'flame',
            href: '/tools/fire-calculator',
        },
        {
            title: 'Mortgage Calculator',
            description: 'Link your mortgage account and track loan details with interest rate configuration.',
            icon: 'house',
            href: '/tools/mortgage',
        },
        {
            title: 'Mortgage Payoff',
            description: 'Estimate payoff timeline with extra payments or calculate the payment needed for a target date.',
            icon: 'calendar',
            href: '/tools/mortgage#payoff',
        },
        {
            title: 'Ask Your Books',
            description: 'Ask questions in plain English, answered by read-only queries against your book.',
            icon: 'chat',
            href: '/tools/ask',
        },
        {
            title: 'Drawdown & Roth Conversion Planner',
            description: 'Model retirement spend-down year by year — withdrawal sequencing, SECURE 2.0 RMDs, IRMAA warnings, and bracket-filling Roth conversions.',
            icon: 'trend',
            href: '/tools/drawdown',
        },
        {
            title: 'Scenario Sandbox',
            description: 'Model one what-if — buy a house, take a raise, add a loan — and compare cash flow, net worth, taxes, and your FI date against baseline.',
            icon: 'sliders',
            href: '/tools/scenario',
        },
        {
            title: 'Sell Planner',
            description: 'Raise a target amount of cash tax-optimally — loss harvesting first, wash-sale screening, and the incremental federal + state tax of each plan vs naive FIFO.',
            icon: 'trend',
            href: '/tools/sell-planner',
        },
        {
            title: 'Tax Estimator',
            description: 'Estimate federal and state taxes from your book data, with contribution scenarios and IRS limit tracking.',
            icon: 'percent',
            href: '/tools/tax-estimator',
        },
        {
            title: 'In Case of Emergency',
            description: 'A printable map of every account — institutions, balances, beneficiaries, and instructions — for the people who would need it.',
            icon: 'shield',
            href: '/tools/emergency',
        },
        {
            title: 'Asset Analysis',
            description: 'View fixed assets with depreciation schedules, appreciation tracking, and valuation history.',
            icon: 'building',
            href: '/assets',
        },
    ];

    const visibleTools = isBusinessBook
        ? tools.filter(tool => !PERSONAL_ONLY_HREFS.has(tool.href.split('#')[0]))
        : tools;

    return (
        <div className="space-y-8">
            <header>
                <h1 className="text-3xl font-bold text-foreground">Tools</h1>
                <p className="text-foreground-muted mt-1">
                    Financial planning and analysis tools.
                </p>
            </header>

            <section className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {visibleTools.map(tool => (
                        <ToolCard
                            key={tool.href}
                            title={tool.title}
                            description={tool.description}
                            icon={tool.icon}
                            href={tool.href}
                        />
                    ))}
                </div>
            </section>
        </div>
    );
}
