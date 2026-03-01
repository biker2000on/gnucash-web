'use client';

import Link from 'next/link';

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
            className="group block bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6 hover:border-cyan-500/50 hover:bg-surface/50 transition-all duration-200"
        >
            <div className="flex items-start gap-4">
                <div className="p-3 bg-gradient-to-br from-cyan-500/20 to-emerald-500/20 rounded-xl text-cyan-400 group-hover:from-cyan-500/30 group-hover:to-emerald-500/30 transition-colors">
                    <ToolIcon icon={icon} />
                </div>
                <div className="flex-1 min-w-0">
                    <h3 className="text-lg font-semibold text-foreground group-hover:text-cyan-400 transition-colors">
                        {title}
                    </h3>
                    <p className="mt-1 text-sm text-foreground-muted line-clamp-2">
                        {description}
                    </p>
                </div>
                <div className="text-foreground-muted group-hover:text-cyan-400 transition-colors">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                </div>
            </div>
        </Link>
    );
}

export default function ToolsPage() {
    const tools = [
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
    ];

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
                    {tools.map(tool => (
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
