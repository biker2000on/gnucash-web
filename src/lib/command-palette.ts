/**
 * Command palette registry and fuzzy matching.
 *
 * Navigation entries derive from the feature registry (single source of
 * truth); only global actions are defined here. The palette (Ctrl+K)
 * searches actions, features, accounts, and transactions.
 */

import { FEATURES, type Feature } from '@/lib/feature-registry';

export type PaletteGroup = 'action' | 'navigate' | 'report' | 'tool' | 'business';

export interface PaletteCommand {
    id: string;
    title: string;
    group: PaletteGroup;
    /** Navigate to this route when selected */
    href?: string;
    /** Dispatch this CustomEvent on window when selected */
    event?: string;
    /** Extra terms to match against besides the title */
    keywords?: string;
    /** Displayed keyboard shortcut hint */
    shortcut?: string;
}

const ACTIONS: PaletteCommand[] = [
    { id: 'act-new-tx', title: 'New Transaction', group: 'action', event: 'open-new-transaction', keywords: 'create add entry', shortcut: 'n' },
    { id: 'act-switch-book', title: 'Switch Book', group: 'action', event: 'open-book-switcher', keywords: 'change book', shortcut: 'g b' },
    { id: 'act-switch-account', title: 'Jump to Account…', group: 'action', event: 'open-account-switcher', keywords: 'quick switcher find', shortcut: 'Ctrl+P' },
    { id: 'act-shortcuts', title: 'Keyboard Shortcuts Help', group: 'action', event: 'open-shortcut-help', keywords: 'keys bindings hotkeys', shortcut: '?' },
    { id: 'act-edit-mode', title: 'Enter Edit Mode', group: 'action', event: 'enter-edit-mode', keywords: 'bulk select', shortcut: 'e' },
];

function paletteGroupFor(feature: Feature): PaletteGroup {
    if (feature.domain === 'business') return 'business';
    if (feature.kind === 'report') return 'report';
    if (feature.kind === 'tool') return 'tool';
    return 'navigate';
}

export const PALETTE_COMMANDS: PaletteCommand[] = [
    ...ACTIONS,
    ...FEATURES.map(f => ({
        id: f.id,
        title: f.title,
        group: paletteGroupFor(f),
        href: f.href,
        // Descriptions are searchable so "raise cash" finds the Sell Planner
        keywords: [f.keywords, f.description].filter(Boolean).join(' '),
        shortcut: f.shortcut,
    })),
];

/**
 * Fuzzy score: higher is better, -1 means no match.
 *
 * Tiers: exact title (1000) > title prefix (600) > word prefix (400) >
 * substring (250) > keyword substring (150) > subsequence (10 + density).
 */
export function fuzzyScore(query: string, title: string, keywords = ''): number {
    const q = query.trim().toLowerCase();
    if (!q) return 0;
    const t = title.toLowerCase();

    if (t === q) return 1000;
    if (t.startsWith(q)) return 600;

    // Word-prefix: any word in the title starts with the query
    const words = t.split(/[\s—:/&()-]+/);
    if (words.some(w => w.startsWith(q))) return 400;

    const idx = t.indexOf(q);
    if (idx >= 0) return 250 - Math.min(idx, 100);

    if (keywords && keywords.toLowerCase().includes(q)) return 150;

    // Subsequence match over the title (e.g. "cgf" → "Cash flow ForeCast")
    let ti = 0;
    let matched = 0;
    for (const ch of q) {
        const found = t.indexOf(ch, ti);
        if (found === -1) return -1;
        matched += 1;
        ti = found + 1;
    }
    if (matched !== q.length) return -1;
    // Denser matches (shorter span) score slightly higher
    return 10 + Math.max(0, 50 - ti);
}

export interface ScoredCommand extends PaletteCommand {
    score: number;
}

/** Filter + rank the static registry for a query. */
export function searchCommands(query: string, commands: PaletteCommand[] = PALETTE_COMMANDS): ScoredCommand[] {
    const q = query.trim();
    if (!q) {
        // Empty query: actions first, then primary navigation
        return commands
            .filter(c => c.group === 'action' || c.group === 'navigate')
            .map(c => ({ ...c, score: c.group === 'action' ? 2 : 1 }));
    }
    return commands
        .map(c => ({ ...c, score: fuzzyScore(q, c.title, c.keywords) }))
        .filter(c => c.score >= 0)
        .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Recents (frecency) — stored client-side, used for empty-query ordering
// ---------------------------------------------------------------------------

const RECENTS_KEY = 'commandPalette.recents.v1';
const RECENTS_MAX = 8;

interface RecentEntry {
    id: string;
    count: number;
    lastUsed: number;
}

export function recordPaletteUse(id: string): void {
    if (typeof window === 'undefined') return;
    try {
        const raw = window.localStorage.getItem(RECENTS_KEY);
        const entries: RecentEntry[] = raw ? JSON.parse(raw) : [];
        const existing = entries.find(e => e.id === id);
        if (existing) {
            existing.count += 1;
            existing.lastUsed = Date.now();
        } else {
            entries.push({ id, count: 1, lastUsed: Date.now() });
        }
        entries.sort((a, b) => b.count * 2 + b.lastUsed / 1e10 - (a.count * 2 + a.lastUsed / 1e10));
        window.localStorage.setItem(RECENTS_KEY, JSON.stringify(entries.slice(0, 24)));
    } catch {
        // localStorage unavailable — recents are best-effort
    }
}

export function recentPaletteCommands(): PaletteCommand[] {
    if (typeof window === 'undefined') return [];
    try {
        const raw = window.localStorage.getItem(RECENTS_KEY);
        const entries: RecentEntry[] = raw ? JSON.parse(raw) : [];
        return entries
            .slice(0, RECENTS_MAX)
            .map(e => PALETTE_COMMANDS.find(c => c.id === e.id))
            .filter((c): c is PaletteCommand => Boolean(c));
    } catch {
        return [];
    }
}
