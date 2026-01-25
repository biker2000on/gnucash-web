"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode } from 'react';
import { UserMenu } from './UserMenu';

export default function Layout({ children }: { children: ReactNode }) {
    const pathname = usePathname();

    const navItems = [
        { name: 'Account Hierarchy', href: '/accounts' },
        { name: 'General Ledger', href: '/ledger' },
        { name: 'Budgets', href: '/budgets' },
        { name: 'Reports', href: '/reports' },
    ];

    return (
        <div className="flex h-screen bg-neutral-950 text-neutral-100 font-sans">
            {/* Sidebar */}
            <aside className="w-64 border-r border-neutral-800 flex flex-col">
                <div className="p-6">
                    <h1 className="text-2xl font-bold bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
                        GnuCash Web
                    </h1>
                </div>
                <nav className="flex-1 px-4 space-y-1">
                    {navItems.map((item) => {
                        const isActive = pathname === item.href;
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                className={`flex items-center px-4 py-3 rounded-xl transition-all duration-200 group ${isActive
                                    ? 'bg-neutral-800 text-emerald-400 shadow-lg shadow-emerald-500/10'
                                    : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'
                                    }`}
                            >
                                <span className="font-medium">{item.name}</span>
                                {isActive && (
                                    <div className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                )}
                            </Link>
                        );
                    })}
                </nav>
                <div className="p-6 border-t border-neutral-800">
                    <div className="text-xs text-neutral-500 uppercase tracking-widest">Status</div>
                    <div className="mt-2 flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-emerald-500" />
                        <span className="text-sm">Read-only Mode</span>
                    </div>
                </div>
            </aside>

            {/* Main Content */}
            <main className="flex-1 overflow-auto bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-neutral-900 via-neutral-950 to-neutral-950">
                {/* Top Bar */}
                <div className="border-b border-neutral-800 bg-neutral-950/50 backdrop-blur-sm sticky top-0 z-10">
                    <div className="max-w-6xl mx-auto px-8 py-3 flex items-center justify-end">
                        <UserMenu />
                    </div>
                </div>
                <div className="max-w-6xl mx-auto p-8">
                    {children}
                </div>
            </main>
        </div>
    );
}
