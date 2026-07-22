"use client";

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ReactNode, ReactElement, useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import { useBooks } from '@/contexts/BookContext';
import { UserMenu } from './UserMenu';
import { NotificationBell } from './NotificationBell';
import { JobProgressStream } from '@/contexts/JobProgressContext';
import BookSwitcher from './BookSwitcher';
import { KeyboardShortcutHelp } from './KeyboardShortcutHelp';
import { GlobalShortcuts } from './GlobalShortcuts';
import { FEATURES, featureById, type FeatureDomain } from '@/lib/feature-registry';
import { isFeatureIdEnabled, type ResolvedBookFeatures } from '@/lib/book-features';

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

function IconWrench({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75a4.5 4.5 0 01-4.884 4.484c-1.076-.091-2.264.071-2.95.904l-7.152 8.684a2.548 2.548 0 11-3.586-3.586l8.684-7.152c.833-.686.995-1.874.904-2.95a4.5 4.5 0 016.336-4.486l-3.276 3.276a3.004 3.004 0 002.25 2.25l3.276-3.276c.256.565.398 1.192.398 1.852z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.867 19.125h.008v.008h-.008v-.008z" />
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

function IconSettings({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
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

function IconPaperclip({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
        </svg>
    );
}

function IconPayslip({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            <path strokeLinecap="round" d="M13 3v5a1 1 0 001 1h5" />
        </svg>
    );
}

// ---------------------------------------------------------------------------
function IconPercent({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 5L5 19" />
            <circle cx="7.5" cy="7.5" r="2.5" strokeWidth={2} />
            <circle cx="16.5" cy="16.5" r="2.5" strokeWidth={2} />
        </svg>
    );
}

function IconPlusCircle({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" strokeWidth={2} />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v8M8 12h8" />
        </svg>
    );
}

// Icon registry map
// ---------------------------------------------------------------------------

function IconStar({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.48 3.5c.2-.4.84-.4 1.04 0l2.13 4.35 4.8.7c.45.06.63.62.3.94l-3.47 3.38.82 4.78c.08.44-.39.78-.79.57L12 15.97l-4.3 2.25c-.4.21-.87-.13-.8-.57l.83-4.78-3.48-3.38c-.32-.32-.14-.88.3-.94l4.8-.7 2.13-4.34z" />
        </svg>
    );
}

const iconMap: Record<string, ({ className }: { className?: string }) => ReactElement> = {
    PlusCircle: IconPlusCircle,
    Percent: IconPercent,
    Star: IconStar,
    LayoutDashboard: IconLayoutDashboard,
    List: IconList,
    BookOpen: IconBookOpen,
    TrendingUp: IconTrendingUp,
    PiggyBank: IconPiggyBank,
    BarChart3: IconBarChart3,
    ArrowUpDown: IconArrowUpDown,
    Building: IconBuilding,
    Wrench: IconWrench,
    Settings: IconSettings,
    Paperclip: IconPaperclip,
    Payslip: IconPayslip,
    Tag: IconTag,
    Target: IconTarget,
    Briefcase: IconBriefcase,
    Statement: IconStatement,
};

function IconStatement({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 2h9l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M14 2v5h5M8 13h8M8 17h5M8 9h3" />
        </svg>
    );
}

function IconBriefcase({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <rect x="3" y="7" width="18" height="13" rx="2" strokeLinecap="round" strokeLinejoin="round" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2M3 12h18" />
        </svg>
    );
}

function IconTag({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M20.59 13.41L12 22 2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
            <circle cx="7" cy="7" r="1" fill="currentColor" stroke="none" />
        </svg>
    );
}

function IconTarget({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="12" cy="12" r="5" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
        </svg>
    );
}

// ---------------------------------------------------------------------------
// Chevron icon for expandable items
// ---------------------------------------------------------------------------

function IconChevronDown({ className = "w-4 h-4" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
    );
}

// ---------------------------------------------------------------------------
// Nav items
// ---------------------------------------------------------------------------

/**
 * Resolve which child in a nav group is active, honoring the query string so
 * sibling items that share a pathname but differ by query (e.g. Invoices at
 * /business/invoices vs Bills at /business/invoices?type=bill) highlight
 * correctly. Returns the href of the single active child, or null.
 */
function resolveActiveChildHref(
    children: Array<{ name: string; href: string }>,
    pathname: string | null,
    search: URLSearchParams,
): string | null {
    if (!pathname) return null;
    // 1. Most specific: a child whose full query string matches the current URL.
    const queryMatch = children.find((c) => {
        const [cPath, cQuery] = c.href.split('?');
        if (cPath !== pathname || !cQuery) return false;
        let all = true;
        new URLSearchParams(cQuery).forEach((v, k) => {
            if (search.get(k) !== v) all = false;
        });
        return all;
    });
    if (queryMatch) return queryMatch.href;
    // 2. Exact-path child with no query — the default when no query sibling matched.
    const plain = children.find((c) => {
        const [cPath, cQuery] = c.href.split('?');
        return cPath === pathname && !cQuery;
    });
    if (plain) return plain.href;
    // 3. Nested route (e.g. /business/invoices/{guid}) highlights its base child.
    const nested = children.find((c) => pathname.startsWith(c.href.split('?')[0] + '/'));
    return nested?.href ?? null;
}

interface NavItem {
    name: string;
    href: string;
    icon: string;
    /** Only shown in the mobile sidebar (e.g. Quick Add's thumb-first capture). */
    mobileOnly?: boolean;
    children?: Array<{
        name: string;
        href: string;
    }>;
}

// Sidebar children derive from the feature registry (single source of truth).
// Task-oriented domains: Home, Money, Budgets & Goals, Investments, Taxes,
// Planning, Reports, Business, Settings.
function registryNavFeatures(domain: FeatureDomain) {
    return FEATURES.filter(f => f.domain === domain && f.nav && !f.mobileOnly);
}

function registryNavChildren(domain: FeatureDomain): Array<{ name: string; href: string }> {
    return registryNavFeatures(domain).map(f => ({ name: f.navTitle ?? f.title, href: f.href }));
}

// Hrefs of personal-finance features (FIRE, withholding, …) that are hidden
// from the sidebar when the active book is a business/nonprofit.
const PERSONAL_ONLY_HREFS = new Set(FEATURES.filter(f => f.personalOnly).map(f => f.href));

// Shown only when the active book's entity profile is a business type.
// Children are filtered by the book's enabled feature modules (invoicing,
// membership, …); a null features map means "not loaded yet — show all".
function buildBusinessNavItem(features: ResolvedBookFeatures | null): NavItem {
    return {
        name: 'Business',
        href: '/business',
        icon: 'Briefcase',
        children: [
            ...registryNavFeatures('business')
                .filter(f => features === null || isFeatureIdEnabled(f.id, features))
                .map(f => ({ name: f.navTitle ?? f.title, href: f.href })),
            // Schedule C/E live in the Taxes domain but stay reachable here too
            { name: 'Schedule C', href: '/business/reports/schedule-c' },
            { name: 'Schedule E', href: '/business/reports/schedule-e' },
        ],
    };
}

const navItems: NavItem[] = [
    {
        name: 'Dashboard',
        href: '/dashboard',
        icon: 'LayoutDashboard',
        children: [
            { name: 'Overview', href: '/dashboard' },
            { name: 'Ask Your Books', href: '/tools/ask' },
            { name: 'Feature Catalog', href: '/catalog' },
        ],
    },
    { name: 'Quick Add', href: '/quick-add', icon: 'PlusCircle', mobileOnly: true },
    { name: 'Money', href: '/money', icon: 'BookOpen', children: registryNavChildren('money') },
    {
        name: 'Budgets & Goals',
        href: '/budgets',
        icon: 'PiggyBank',
        children: [
            ...registryNavChildren('budgets'),
            { name: 'Budget Income Statement', href: '/reports/budget_income_statement' },
        ],
    },
    { name: 'Investments', href: '/investments', icon: 'TrendingUp', children: registryNavChildren('investments') },
    { name: 'Taxes', href: '/taxes', icon: 'Percent', children: registryNavChildren('taxes') },
    { name: 'Planning', href: '/planning', icon: 'Wrench', children: registryNavChildren('planning') },
    { name: 'Reports', href: '/reports', icon: 'BarChart3' },
    { name: 'Settings', href: '/settings', icon: 'Settings', children: registryNavChildren('settings') },
];

// ---------------------------------------------------------------------------
// localStorage key
// ---------------------------------------------------------------------------

const SIDEBAR_COLLAPSED_KEY = 'sidebar-collapsed';
const SIDEBAR_WIDTH_KEY = 'sidebar-width';
const DEFAULT_SIDEBAR_WIDTH = 256;
const MIN_SIDEBAR_WIDTH = 150;
const MAX_SIDEBAR_WIDTH = 500;

const subscribe = () => () => undefined;

// ---------------------------------------------------------------------------
// Layout component
// ---------------------------------------------------------------------------

export default function Layout({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const router = useRouter();
    const searchParams = useSearchParams();

    // Restricted 'timekeeper' role: the sidebar collapses to just Time (+ the
    // book switcher and user menu) and financial APIs are never called from
    // here. The API layer is the security boundary — this is UX.
    const { books, activeBookGuid, loading: booksLoading } = useBooks();
    const activeBookRole = books.find((b) => b.guid === activeBookGuid)?.role;
    const isTimekeeper = activeBookRole === 'timekeeper';

    // Timekeepers land on the timesheet, not the financial dashboard.
    useEffect(() => {
        if (!isTimekeeper) return;
        if (pathname === '/' || pathname === '/dashboard' || pathname?.startsWith('/dashboard/')) {
            router.replace('/business/time');
        }
    }, [isTimekeeper, pathname, router]);

    // Business nav group is gated on the active book's entity type — household
    // books never see AR/AP features. Re-checked when the book changes (the
    // BookSwitcher triggers a full navigation, so mount-time fetch suffices).
    const [isBusinessBook, setIsBusinessBook] = useState(false);
    // Feature modules enabled on the active book (invoicing, membership, …);
    // null until loaded. Filters the Business nav group's children.
    const [bookFeatures, setBookFeatures] = useState<ResolvedBookFeatures | null>(null);
    // Household books can opt in to inventory via Settings (inventory_settings
    // tool config); business books always have it inside the Business group.
    const [householdInventory, setHouseholdInventory] = useState(false);
    useEffect(() => {
        // Timekeepers get a minimal nav and must not trigger the financial
        // entity/feature/inventory endpoints (they would 403 anyway). Wait
        // for the books list so the role is known before fetching.
        if (booksLoading || isTimekeeper) return;
        let cancelled = false;
        const fetchBookFeatures = () => {
            fetch('/api/book-features')
                .then(res => (res.ok ? res.json() : null))
                .then(data => {
                    if (!cancelled && data?.features) setBookFeatures(data.features);
                })
                .catch(() => { /* show all business children on failure */ });
        };
        const refresh = () => {
            fetch('/api/entity')
                .then(res => (res.ok ? res.json() : null))
                .then(profile => {
                    if (!cancelled && profile?.entityType) {
                        setIsBusinessBook(profile.entityType !== 'household');
                    }
                })
                .catch(() => { /* stay hidden on failure */ });
            fetchBookFeatures();
            fetch('/api/inventory/settings')
                .then(res => (res.ok ? res.json() : null))
                .then(s => {
                    if (!cancelled && s) setHouseholdInventory(s.enabledForHousehold === true);
                })
                .catch(() => { /* stay hidden */ });
        };
        refresh();
        window.addEventListener('inventory-settings-updated', refresh);

        // React immediately when a module is toggled on the settings page.
        window.addEventListener('book-features-updated', fetchBookFeatures);

        // React immediately when the entity type is changed on the settings
        // page — no refresh needed to reveal/hide the Business nav group.
        // (Book switches do a full page reload, which re-runs the fetch above.)
        const onEntityUpdated = (e: Event) => {
            const type = (e as CustomEvent<{ entityType?: string }>).detail?.entityType;
            if (type) setIsBusinessBook(type !== 'household');
            else refresh();
            // The entity type drives the module defaults, so re-resolve them.
            fetchBookFeatures();
        };
        window.addEventListener('entity-updated', onEntityUpdated);
        return () => {
            cancelled = true;
            window.removeEventListener('entity-updated', onEntityUpdated);
            window.removeEventListener('book-features-updated', fetchBookFeatures);
            window.removeEventListener('inventory-settings-updated', refresh);
        };
    }, [booksLoading, isTimekeeper]);

    // Pinned favorites (feature ids) — synced via user preferences; the
    // catalog page edits them and fires 'pinned-features-changed'.
    const [pinnedFeatureIds, setPinnedFeatureIds] = useState<string[]>([]);
    useEffect(() => {
        const load = () => {
            fetch('/api/user/preferences?key=pinned_features')
                .then(r => (r.ok ? r.json() : null))
                .then(data => {
                    const pins = data?.preferences?.pinned_features;
                    setPinnedFeatureIds(Array.isArray(pins) ? pins.filter((p: unknown) => typeof p === 'string') : []);
                })
                .catch(() => undefined);
        };
        load();
        window.addEventListener('pinned-features-changed', load);
        return () => window.removeEventListener('pinned-features-changed', load);
    }, []);

    const effectiveNavItems = (() => {
        // Timekeepers: minimal sidebar — just Time.
        if (isTimekeeper) {
            return [{ name: 'Time', href: '/business/time', icon: 'Briefcase' } as NavItem];
        }

        // Business books hide personal-finance children (FIRE, withholding, …)
        const stripPersonalOnly = (items: NavItem[]): NavItem[] =>
            !isBusinessBook
                ? items
                : items.map(item =>
                    item.children
                        ? { ...item, children: item.children.filter(c => !PERSONAL_ONLY_HREFS.has(c.href)) }
                        : item,
                );

        // Pinned favorites float to the top, just under Home
        const withPins = (items: NavItem[]): NavItem[] => {
            if (pinnedFeatureIds.length === 0) return items;
            const children = pinnedFeatureIds
                .map(id => featureById(id))
                .filter((f): f is NonNullable<ReturnType<typeof featureById>> => Boolean(f))
                .filter(f => (!isBusinessBook || !f.personalOnly)
                    && (bookFeatures === null || isFeatureIdEnabled(f.id, bookFeatures)))
                .map(f => ({ name: f.navTitle ?? f.title, href: f.href }));
            if (children.length === 0) return items;
            const pinnedItem: NavItem = { name: 'Pinned', href: children[0].href, icon: 'Star', children };
            return [items[0], pinnedItem, ...items.slice(1)];
        };

        // Business (or the standalone Inventory item) slots before Settings
        const settingsAnchor = (items: NavItem[]) => {
            const idx = items.findIndex(i => i.href === '/settings');
            return idx >= 0 ? idx : items.length;
        };
        if (isBusinessBook) {
            const items = stripPersonalOnly([...navItems]);
            items.splice(settingsAnchor(items), 0, buildBusinessNavItem(bookFeatures));
            return withPins(items);
        }
        if (householdInventory) {
            const items = [...navItems];
            const inventoryItem: NavItem = { name: 'Inventory', href: '/business/inventory', icon: 'Briefcase' };
            items.splice(settingsAnchor(items), 0, inventoryItem);
            return withPins(items);
        }
        return withPins([...navItems]);
    })();

    // Data-dense pages use the full content width to reduce horizontal scrolling.
    const isFullWidthPage =
        (pathname?.startsWith('/budgets/') && pathname !== '/budgets/') ||
        pathname === '/ledger' ||
        pathname === '/settings/commodities' ||
        (pathname?.startsWith('/accounts/') && pathname !== '/accounts/') ||
        pathname === '/reports/income_statement_by_period';

    // Desktop collapsed state -- initialised to false, hydrated from localStorage
    const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
    const storedCollapsed = useSyncExternalStore(
        subscribe,
        () => {
            try {
                return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
            } catch {
                return false;
            }
        },
        () => false
    );
    const storedSidebarWidth = useSyncExternalStore(
        subscribe,
        () => {
            try {
                const storedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
                if (!storedWidth) {
                    return DEFAULT_SIDEBAR_WIDTH;
                }

                const width = parseInt(storedWidth, 10);
                return width >= MIN_SIDEBAR_WIDTH && width <= MAX_SIDEBAR_WIDTH
                    ? width
                    : DEFAULT_SIDEBAR_WIDTH;
            } catch {
                return DEFAULT_SIDEBAR_WIDTH;
            }
        },
        () => DEFAULT_SIDEBAR_WIDTH
    );
    const [collapsedOverride, setCollapsedOverride] = useState<boolean | null>(null);
    const [sidebarWidthOverride, setSidebarWidthOverride] = useState<number | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const sidebarWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
    const collapsed = collapsedOverride ?? storedCollapsed;
    const sidebarWidth = sidebarWidthOverride ?? storedSidebarWidth;

    // Mobile open/close state
    const [mobileSidebarState, setMobileSidebarState] = useState<{ open: boolean; pathname: string | null }>({
        open: false,
        pathname,
    });
    const mobileOpen = mobileSidebarState.open && mobileSidebarState.pathname === pathname;

    // Expandable nav sections (e.g. Investments sub-items)
    const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

    // Keep sidebarWidthRef in sync with sidebarWidth state
    useEffect(() => {
        sidebarWidthRef.current = sidebarWidth;
    }, [sidebarWidth]);

    // Auto-expand nav sections when pathname matches a child route
    useEffect(() => {
        effectiveNavItems.forEach((item) => {
            if (item.children) {
                const matchesChild = item.children.some((child) => {
                    const childPath = child.href.split('?')[0];
                    return pathname === childPath || pathname?.startsWith(childPath + '/');
                });
                if (matchesChild) {
                    setExpandedSections((prev) => {
                        if (prev.has(item.name)) return prev;
                        const next = new Set(prev);
                        next.add(item.name);
                        return next;
                    });
                }
            }
        });
        // effectiveNavItems depends on isBusinessBook; re-run when either changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pathname, isBusinessBook]);

    // Persist collapsed state to localStorage
    const toggleCollapsed = useCallback(() => {
        const next = !collapsed;
        setCollapsedOverride(next);
        try {
            localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
        } catch {
            // ignore
        }
    }, [collapsed]);

    const handleDragStart = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = sidebarWidthRef.current;
        setIsDragging(true);

        const handleMove = (moveEvent: PointerEvent) => {
            const newWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, startWidth + (moveEvent.clientX - startX)));
            setSidebarWidthOverride(newWidth);
        };

        const handleUp = () => {
            setIsDragging(false);
            document.removeEventListener('pointermove', handleMove);
            document.removeEventListener('pointerup', handleUp);
            try {
                localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidthRef.current));
            } catch {
                // ignore
            }
        };

        document.addEventListener('pointermove', handleMove);
        document.addEventListener('pointerup', handleUp);
    }, []);

    // Apply global cursor/select styles while dragging
    useEffect(() => {
        if (isDragging) {
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';
        } else {
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
        }
        return () => {
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
        };
    }, [isDragging]);

    // -----------------------------------------------------------------------
    // Sidebar content (shared between desktop and mobile)
    // -----------------------------------------------------------------------

    function renderNavItem(item: NavItem) {
        const isActive = pathname === item.href || (item.href !== '/' && pathname?.startsWith(item.href + '/'));
        const activeChildHref = item.children
            ? resolveActiveChildHref(item.children, pathname, searchParams ?? new URLSearchParams())
            : null;
        const Icon = iconMap[item.icon];
        const isSectionExpanded = expandedSections.has(item.name);
        const isCollapsed = collapsed && hydrated;

        const handleParentClick = () => {
            if (item.children && !isCollapsed) {
                // Toggle expand/collapse of sub-items
                setExpandedSections((prev) => {
                    const next = new Set(prev);
                    if (next.has(item.name)) {
                        next.delete(item.name);
                    } else {
                        next.add(item.name);
                    }
                    return next;
                });
                return;
            }
            setMobileSidebarState({ open: false, pathname });
        };

        const parentClasses = `relative flex items-center rounded-xl transition-all duration-200 group
                        ${isCollapsed ? 'justify-center px-0 py-3' : 'px-4 py-3'}
                        ${isActive
                            ? 'bg-sidebar-active-bg text-sidebar-text-active shadow-lg shadow-primary/10'
                            : 'text-sidebar-text hover:bg-sidebar-hover hover:text-foreground'
                        }`;

        const content = (
            <>
                {Icon && (
                    <span className={isCollapsed ? '' : 'mr-3'}>
                        <Icon className="w-5 h-5 shrink-0" />
                    </span>
                )}
                {/* Label: hidden when collapsed on desktop */}
                <span
                    className={`font-medium whitespace-nowrap transition-opacity duration-200
                        ${isCollapsed ? 'hidden' : 'block'}`}
                >
                    {item.name}
                </span>
                {/* Chevron for expandable items */}
                {item.children && !isCollapsed && (
                    <IconChevronDown
                        className={`ml-auto w-4 h-4 transition-transform duration-200 ${isSectionExpanded ? '' : '-rotate-90'}`}
                    />
                )}
                {/* Active dot (only for items without children) */}
                {isActive && !item.children && !isCollapsed && (
                    <div className="ml-auto w-1.5 h-1.5 rounded-full bg-sidebar-text-active animate-pulse" />
                )}
                {/* Tooltip when collapsed */}
                {isCollapsed && (
                    <span className="absolute left-full ml-2 px-2 py-1 rounded-md bg-surface-elevated text-foreground text-xs font-medium whitespace-nowrap shadow-lg opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity duration-150 z-50">
                        {item.name}
                    </span>
                )}
            </>
        );

        return (
            <div key={item.href}>
                {item.children && !isCollapsed ? (
                    <button
                        type="button"
                        onClick={handleParentClick}
                        className={`${parentClasses} w-full text-left`}
                        aria-expanded={isSectionExpanded}
                    >
                        {content}
                    </button>
                ) : (
                    <Link
                        href={item.href}
                        onClick={handleParentClick}
                        className={parentClasses}
                    >
                        {content}
                    </Link>
                )}
                {/* Sub-items (desktop expanded only) */}
                {item.children && isSectionExpanded && !isCollapsed && (
                    <div className="ml-8 mt-1 space-y-0.5">
                        {item.children.map((child) => {
                            const isChildActive = child.href === activeChildHref;
                            return (
                                <Link
                                    key={child.href}
                                    href={child.href}
                                    onClick={() => setMobileSidebarState({ open: false, pathname })}
                                    className={`block px-3 py-2.5 min-h-[44px] flex items-center text-sm rounded-lg transition-colors
                                        ${isChildActive
                                            ? 'text-sidebar-text-active bg-sidebar-active-bg/50'
                                            : 'text-foreground-muted hover:text-foreground-secondary hover:bg-sidebar-hover/50'
                                        }`}
                                >
                                    {child.name}
                                </Link>
                            );
                        })}
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="flex h-screen bg-background text-foreground font-sans">
            <GlobalShortcuts />
            <KeyboardShortcutHelp />
            {/* ============================================================= */}
            {/* Desktop Sidebar                                                */}
            {/* ============================================================= */}
            <aside
                className={`hidden md:flex flex-col border-r border-sidebar-border bg-sidebar-bg shrink-0 relative
                    ${!isDragging ? 'transition-all duration-300' : ''}`}
                style={collapsed && hydrated ? { width: '4rem' } : { width: `${sidebarWidth}px` }}
            >
                {/* Header with title + collapse button */}
                <div className={`flex items-center border-b border-sidebar-border transition-all duration-300
                    ${collapsed && hydrated ? 'justify-center px-2 py-4' : 'justify-between px-6 py-4'}`}>
                    {/* Title (hidden when collapsed) */}
                    {!(collapsed && hydrated) && (
                        <h1 className="text-xl font-bold text-primary truncate">
                            GnuCash Web
                        </h1>
                    )}
                    <button
                        onClick={toggleCollapsed}
                        className="p-2.5 rounded-lg text-sidebar-text hover:bg-sidebar-hover hover:text-foreground transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
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

                {/* Global search (opens the command palette; hidden for timekeepers) */}
                {!isTimekeeper && (
                <div className={`transition-all duration-300 ${collapsed && hydrated ? 'px-2 pt-3' : 'px-4 pt-3'}`}>
                    <button
                        type="button"
                        onClick={() => window.dispatchEvent(new CustomEvent('open-command-palette'))}
                        className={`w-full flex items-center gap-2 rounded-lg border border-sidebar-border bg-background/40 text-sidebar-text hover:text-foreground hover:border-border-hover transition-colors duration-150 ${
                            collapsed && hydrated ? 'justify-center px-0 py-2' : 'px-3 py-2'
                        }`}
                        title="Search everything (Ctrl+K)"
                    >
                        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                        {!(collapsed && hydrated) && (
                            <>
                                <span className="flex-1 text-left text-sm">Search…</span>
                                <kbd className="text-[10px] px-1.5 py-0.5 rounded border border-sidebar-border">Ctrl K</kbd>
                            </>
                        )}
                    </button>
                </div>
                )}

                {/* Nav links (mobile-only items like Quick Add are excluded on desktop) */}
                <nav className={`flex-1 space-y-1 overflow-y-auto overflow-x-hidden transition-all duration-300
                    ${collapsed && hydrated ? 'px-2 py-4' : 'px-4 py-4'}`}>
                    {effectiveNavItems.filter((item) => !item.mobileOnly).map(renderNavItem)}
                </nav>

                {/* Drag handle */}
                {!(collapsed && hydrated) && (
                    <div
                        onPointerDown={handleDragStart}
                        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors z-10"
                        title="Drag to resize sidebar"
                    />
                )}
            </aside>

            {/* ============================================================= */}
            {/* Mobile Sidebar Overlay                                         */}
            {/* ============================================================= */}
            {/* Backdrop */}
            {mobileOpen && (
                <div
                    className="fixed inset-0 z-40 bg-black/50 md:hidden"
                    onClick={() => setMobileSidebarState({ open: false, pathname })}
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
                    <h1 className="text-xl font-bold text-primary">
                        GnuCash Web
                    </h1>
                    <button
                        onClick={() => setMobileSidebarState({ open: false, pathname })}
                        className="p-2.5 rounded-lg text-sidebar-text hover:bg-sidebar-hover hover:text-foreground transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
                        aria-label="Close sidebar"
                    >
                        <IconX className="w-5 h-5" />
                    </button>
                </div>

                {/* Mobile Book Switcher */}
                <div className="px-4 py-2 border-b border-sidebar-border">
                    <BookSwitcher />
                </div>

                {/* Global search (opens the command palette; hidden for timekeepers) */}
                {!isTimekeeper && (
                <div className="px-4 pt-3">
                    <button
                        type="button"
                        onClick={() => {
                            setMobileSidebarState({ open: false, pathname });
                            window.dispatchEvent(new CustomEvent('open-command-palette'));
                        }}
                        className="w-full flex items-center gap-2 rounded-lg border border-sidebar-border bg-background/40 text-sidebar-text px-3 py-2.5"
                    >
                        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                        <span className="flex-1 text-left text-sm">Search everything…</span>
                    </button>
                </div>
                )}

                {/* Mobile nav links (always expanded) */}
                <nav className="flex-1 px-4 py-4 space-y-1 overflow-y-auto">
                    {effectiveNavItems.map((item) => {
                        const isActive = pathname === item.href || (item.href !== '/' && pathname?.startsWith(item.href + '/'));
                        const activeChildHref = item.children
                            ? resolveActiveChildHref(item.children, pathname, searchParams ?? new URLSearchParams())
                            : null;
                        const Icon = iconMap[item.icon];
                        const isSectionExpanded = expandedSections.has(item.name);

                        const handleMobileParentClick = () => {
                            if (item.children) {
                                setExpandedSections((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(item.name)) {
                                        next.delete(item.name);
                                    } else {
                                        next.add(item.name);
                                    }
                                    return next;
                                });
                                return;
                            }
                            setMobileSidebarState({ open: false, pathname });
                        };

                        const mobileParentClasses = `flex items-center px-4 py-3 rounded-xl transition-all duration-200
                                        ${isActive
                                            ? 'bg-sidebar-active-bg text-sidebar-text-active shadow-lg shadow-primary/10'
                                            : 'text-sidebar-text hover:bg-sidebar-hover hover:text-foreground'
                                        }`;

                        const mobileContent = (
                            <>
                                {Icon && <Icon className="w-5 h-5 mr-3 shrink-0" />}
                                <span className="font-medium">{item.name}</span>
                                {item.children ? (
                                    <IconChevronDown
                                        className={`ml-auto w-4 h-4 transition-transform duration-200 ${isSectionExpanded ? '' : '-rotate-90'}`}
                                    />
                                ) : (
                                    isActive && (
                                        <div className="ml-auto w-1.5 h-1.5 rounded-full bg-sidebar-text-active animate-pulse" />
                                    )
                                )}
                            </>
                        );

                        return (
                            <div key={item.href}>
                                {item.children ? (
                                    <button
                                        type="button"
                                        onClick={handleMobileParentClick}
                                        className={`${mobileParentClasses} w-full text-left`}
                                        aria-expanded={isSectionExpanded}
                                    >
                                        {mobileContent}
                                    </button>
                                ) : (
                                    <Link
                                        href={item.href}
                                        onClick={handleMobileParentClick}
                                        className={mobileParentClasses}
                                    >
                                        {mobileContent}
                                    </Link>
                                )}
                                {/* Mobile sub-items */}
                                {item.children && isSectionExpanded && (
                                    <div className="ml-8 mt-1 space-y-0.5">
                                        {item.children.map((child) => {
                                            const isChildActive = child.href === activeChildHref;
                                            return (
                                                <Link
                                                    key={child.href}
                                                    href={child.href}
                                                    onClick={() => setMobileSidebarState({ open: false, pathname })}
                                                    className={`block px-3 py-2.5 min-h-[44px] flex items-center text-sm rounded-lg transition-colors
                                                        ${isChildActive
                                                            ? 'text-sidebar-text-active bg-sidebar-active-bg/50'
                                                            : 'text-foreground-muted hover:text-foreground-secondary hover:bg-sidebar-hover/50'
                                                        }`}
                                                >
                                                    {child.name}
                                                </Link>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
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
                            onClick={() => setMobileSidebarState({ open: true, pathname })}
                            className="p-2 -ml-2 rounded-lg text-foreground-secondary hover:bg-surface-hover hover:text-foreground transition-colors md:hidden"
                            aria-label="Open sidebar"
                        >
                            <IconMenu className="w-6 h-6" />
                        </button>

                        {/* Spacer pushes UserMenu to right on desktop */}
                        <div className="hidden md:block" />

                        <div className="flex items-center gap-2">
                            <NotificationBell />
                            <JobProgressStream />
                            <UserMenu />
                        </div>
                    </div>
                </div>

                <div className={`p-4 md:p-8 ${isFullWidthPage ? '' : 'max-w-6xl mx-auto'}`}>
                    {children}
                </div>
            </main>
        </div>
    );
}
