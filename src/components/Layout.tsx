"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode, ReactElement, useState, useEffect, useCallback } from 'react';
import { UserMenu } from './UserMenu';
import BookSwitcher from './BookSwitcher';

// ---------------------------------------------------------------------------
// Inline SVG icon components (no external icon library)
// ---------------------------------------------------------------------------

function IconLayoutDashboard({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <rect x="3" y="3" width="7" height="9" rx="1" />
            <rect x="14" y="3" width="7" height="5" rx="1" />
            <rect x="3" y="16" width="7" height="5" rx="1" />
            <rect x="14" y="12" width="7" height="9" rx="1" />
        </svg>
    );
}

function IconList({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
        </svg>
    );
}

function IconBookOpen({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.25278C12 6.25278 10.5 3 7 3C3.5 3 2 5 2 7.5V19.5C2 19.5 3.5 18 7 18C10.5 18 12 20 12 20M12 6.25278C12 6.25278 13.5 3 17 3C20.5 3 22 5 22 7.5V19.5C22 19.5 20.5 18 17 18C13.5 18 12 20 12 20M12 6.25278V20" />
        </svg>
    );
}

function IconTrendingUp({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M22 7l-7 7-4-4-8 8" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 7h6v6" />
        </svg>
    );
}

function IconPiggyBank({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 10c0-1.5-.5-3-2-4M10 4.5C7 4.5 4 7 4 10.5c0 2 .5 3 1.5 4L5 18h3l.5-1h7l.5 1h3l-.5-3.5c1-.5 2-2 2-4.5 0-1-.5-3-2-4" />
            <circle cx="14" cy="10" r="1" fill="currentColor" stroke="none" />
            <path strokeLinecap="round" d="M10 4.5C10 3.12 11.12 2 12.5 2S15 3.12 15 4.5" />
        </svg>
    );
}

function IconBarChart3({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" d="M3 3v18h18" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M7 16v-3M11 16V9M15 16v-5M19 16V7" />
        </svg>
    );
}

function IconArrowUpDown({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
        </svg>
    );
}

function IconBuilding({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4M9 9v.01M9 12v.01M9 15v.01M9 18v.01" />
        </svg>
    );
}

function IconChevronLeft({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
    );
}

function IconMenu({ className = "w-6 h-6" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
    );
}

function IconX({ className = "w-6 h-6" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
    );
}

// ---------------------------------------------------------------------------
// Icon registry map
// ---------------------------------------------------------------------------

const iconMap: Record<string, ({ className }: { className?: string }) => ReactElement> = {
    LayoutDashboard: IconLayoutDashboard,
    List: IconList,
    BookOpen: IconBookOpen,
    TrendingUp: IconTrendingUp,
    PiggyBank: IconPiggyBank,
    BarChart3: IconBarChart3,
    ArrowUpDown: IconArrowUpDown,
    Building: IconBuilding,
};

// ---------------------------------------------------------------------------
// Nav items
// ---------------------------------------------------------------------------

const navItems = [
    { name: 'Dashboard', href: '/dashboard', icon: 'LayoutDashboard' },
    { name: 'Account Hierarchy', href: '/accounts', icon: 'List' },
    { name: 'General Ledger', href: '/ledger', icon: 'BookOpen' },
    { name: 'Investments', href: '/investments', icon: 'TrendingUp' },
    { name: 'Assets', href: '/assets', icon: 'Building' },
    { name: 'Budgets', href: '/budgets', icon: 'PiggyBank' },
    { name: 'Reports', href: '/reports', icon: 'BarChart3' },
    { name: 'Import/Export', href: '/import-export', icon: 'ArrowUpDown' },
];

// ---------------------------------------------------------------------------
// localStorage key
// ---------------------------------------------------------------------------

const SIDEBAR_COLLAPSED_KEY = 'sidebar-collapsed';

// ---------------------------------------------------------------------------
// Layout component
// ---------------------------------------------------------------------------

export default function Layout({ children }: { children: ReactNode }) {
    const pathname = usePathname();

    // Budget detail pages need full width for the period columns
    const isFullWidthPage = pathname?.startsWith('/budgets/') && pathname !== '/budgets/';

    // Desktop collapsed state -- initialised to false, hydrated from localStorage
    const [collapsed, setCollapsed] = useState(false);
    const [hydrated, setHydrated] = useState(false);

    // Mobile open/close state
    const [mobileOpen, setMobileOpen] = useState(false);

    // Hydrate collapsed state from localStorage on mount
    useEffect(() => {
        try {
            const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
            if (stored === 'true') {
                setCollapsed(true);
            }
        } catch {
            // SSR or access denied -- ignore
        }
        setHydrated(true);
    }, []);

    // Persist collapsed state to localStorage
    const toggleCollapsed = useCallback(() => {
        setCollapsed((prev) => {
            const next = !prev;
            try {
                localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
            } catch {
                // ignore
            }
            return next;
        });
    }, []);

    // Close mobile sidebar on pathname change
    useEffect(() => {
        setMobileOpen(false);
    }, [pathname]);

    // -----------------------------------------------------------------------
    // Sidebar content (shared between desktop and mobile)
    // -----------------------------------------------------------------------

    function renderNavItem(item: (typeof navItems)[number]) {
        const isActive = pathname === item.href || (item.href !== '/' && pathname?.startsWith(item.href + '/'));
        const Icon = iconMap[item.icon];

        return (
            <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={`relative flex items-center rounded-xl transition-all duration-200 group
                    ${collapsed && hydrated ? 'justify-center px-0 py-3' : 'px-4 py-3'}
                    ${isActive
                        ? 'bg-sidebar-active-bg text-sidebar-text-active shadow-lg shadow-emerald-500/10'
                        : 'text-sidebar-text hover:bg-sidebar-hover hover:text-foreground'
                    }`}
            >
                {Icon && (
                    <span className={collapsed && hydrated ? '' : 'mr-3'}>
                        <Icon className="w-5 h-5 shrink-0" />
                    </span>
                )}
                {/* Label: hidden when collapsed on desktop, always visible on mobile overlay */}
                <span
                    className={`font-medium whitespace-nowrap transition-opacity duration-200
                        ${collapsed && hydrated ? 'hidden' : 'block'}`}
                >
                    {item.name}
                </span>
                {isActive && !(collapsed && hydrated) && (
                    <div className="ml-auto w-1.5 h-1.5 rounded-full bg-sidebar-text-active animate-pulse" />
                )}
                {/* Tooltip when collapsed */}
                {collapsed && hydrated && (
                    <span className="absolute left-full ml-2 px-2 py-1 rounded-md bg-surface-elevated text-foreground text-xs font-medium whitespace-nowrap shadow-lg opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity duration-150 z-50">
                        {item.name}
                    </span>
                )}
            </Link>
        );
    }

    return (
        <div className="flex h-screen bg-background text-foreground font-sans">
            {/* ============================================================= */}
            {/* Desktop Sidebar                                                */}
            {/* ============================================================= */}
            <aside
                className={`hidden md:flex flex-col border-r border-sidebar-border bg-sidebar-bg transition-all duration-300 shrink-0
                    ${collapsed && hydrated ? 'w-16' : 'w-64'}`}
            >
                {/* Header with title + collapse button */}
                <div className={`flex items-center border-b border-sidebar-border transition-all duration-300
                    ${collapsed && hydrated ? 'justify-center px-2 py-4' : 'justify-between px-6 py-4'}`}>
                    {/* Title (hidden when collapsed) */}
                    {!(collapsed && hydrated) && (
                        <h1 className="text-xl font-bold bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent truncate">
                            GnuCash Web
                        </h1>
                    )}
                    <button
                        onClick={toggleCollapsed}
                        className="p-1.5 rounded-lg text-sidebar-text hover:bg-sidebar-hover hover:text-foreground transition-colors"
                        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                    >
                        <IconChevronLeft
                            className={`w-5 h-5 transition-transform duration-300 ${collapsed && hydrated ? 'rotate-180' : ''}`}
                        />
                    </button>
                </div>

                {/* Book Switcher */}
                <div className={`border-b border-sidebar-border transition-all duration-300
                    ${collapsed && hydrated ? 'px-2 py-2' : 'px-4 py-2'}`}>
                    <BookSwitcher collapsed={collapsed && hydrated} />
                </div>

                {/* Nav links */}
                <nav className={`flex-1 space-y-1 overflow-y-auto overflow-x-hidden transition-all duration-300
                    ${collapsed && hydrated ? 'px-2 py-4' : 'px-4 py-4'}`}>
                    {navItems.map(renderNavItem)}
                </nav>
            </aside>

            {/* ============================================================= */}
            {/* Mobile Sidebar Overlay                                         */}
            {/* ============================================================= */}
            {/* Backdrop */}
            {mobileOpen && (
                <div
                    className="fixed inset-0 z-40 bg-black/50 md:hidden"
                    onClick={() => setMobileOpen(false)}
                    aria-hidden="true"
                />
            )}

            {/* Slide-in panel */}
            <aside
                className={`fixed inset-y-0 left-0 z-40 w-64 bg-surface-elevated border-r border-sidebar-border flex flex-col transform transition-transform duration-300 md:hidden
                    ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
            >
                {/* Mobile header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-sidebar-border">
                    <h1 className="text-xl font-bold bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
                        GnuCash Web
                    </h1>
                    <button
                        onClick={() => setMobileOpen(false)}
                        className="p-1.5 rounded-lg text-sidebar-text hover:bg-sidebar-hover hover:text-foreground transition-colors"
                        aria-label="Close sidebar"
                    >
                        <IconX className="w-5 h-5" />
                    </button>
                </div>

                {/* Mobile Book Switcher */}
                <div className="px-4 py-2 border-b border-sidebar-border">
                    <BookSwitcher />
                </div>

                {/* Mobile nav links (always expanded) */}
                <nav className="flex-1 px-4 py-4 space-y-1 overflow-y-auto">
                    {navItems.map((item) => {
                        const isActive = pathname === item.href || (item.href !== '/' && pathname?.startsWith(item.href + '/'));
                        const Icon = iconMap[item.icon];
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                onClick={() => setMobileOpen(false)}
                                className={`flex items-center px-4 py-3 rounded-xl transition-all duration-200
                                    ${isActive
                                        ? 'bg-sidebar-active-bg text-sidebar-text-active shadow-lg shadow-emerald-500/10'
                                        : 'text-sidebar-text hover:bg-sidebar-hover hover:text-foreground'
                                    }`}
                            >
                                {Icon && <Icon className="w-5 h-5 mr-3 shrink-0" />}
                                <span className="font-medium">{item.name}</span>
                                {isActive && (
                                    <div className="ml-auto w-1.5 h-1.5 rounded-full bg-sidebar-text-active animate-pulse" />
                                )}
                            </Link>
                        );
                    })}
                </nav>
            </aside>

            {/* ============================================================= */}
            {/* Main Content                                                   */}
            {/* ============================================================= */}
            <main className="flex-1 overflow-auto bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-background-secondary via-background to-background min-w-0">
                {/* Top Bar */}
                <div className="border-b border-border bg-input-bg/80 backdrop-blur-sm sticky top-0 z-10">
                    <div className="px-4 md:px-8 py-3 flex items-center justify-between">
                        {/* Hamburger: mobile only */}
                        <button
                            onClick={() => setMobileOpen(true)}
                            className="p-2 -ml-2 rounded-lg text-foreground-secondary hover:bg-surface-hover hover:text-foreground transition-colors md:hidden"
                            aria-label="Open sidebar"
                        >
                            <IconMenu className="w-6 h-6" />
                        </button>

                        {/* Spacer pushes UserMenu to right on desktop */}
                        <div className="hidden md:block" />

                        <UserMenu />
                    </div>
                </div>

                <div className={`p-4 md:p-8 ${isFullWidthPage ? '' : 'max-w-6xl mx-auto'}`}>
                    {children}
                </div>
            </main>
        </div>
    );
}
