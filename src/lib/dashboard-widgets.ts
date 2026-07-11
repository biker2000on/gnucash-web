/**
 * Dashboard widget registry + custom widget definitions.
 *
 * Pure module (no React) so registry filtering and custom-def validation are
 * unit-testable. Rendering lives in src/components/dashboard/widgets/ and is
 * wired up in src/app/(main)/dashboard/page.tsx.
 *
 * Persistence keys (gnucash_web_user_preferences, per user):
 *   - `dashboard.layout`        ordered [{ id, width }] (see dashboard-layout.ts)
 *   - `dashboard.customWidgets` array of CustomWidgetDef
 */

import {
    BuiltinWidgetId,
    CustomWidgetId,
    WidgetWidth,
    WIDGET_META,
    ALL_WIDGET_IDS,
    isCustomWidgetId,
} from './dashboard-layout';

export const LAYOUT_PREF_KEY = 'dashboard.layout';
export const CUSTOM_WIDGETS_PREF_KEY = 'dashboard.customWidgets';

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export type WidgetCategory = 'overview' | 'budgets' | 'investments' | 'business' | 'tools';

export const CATEGORY_ORDER: WidgetCategory[] = [
    'overview',
    'budgets',
    'investments',
    'business',
    'tools',
];

export const CATEGORY_LABELS: Record<WidgetCategory, string> = {
    overview: 'Overview',
    budgets: 'Budgets',
    investments: 'Investments',
    business: 'Business',
    tools: 'Tools',
};

export interface WidgetRegistryEntry {
    id: BuiltinWidgetId;
    title: string;
    description: string;
    category: WidgetCategory;
    /** Width used when the widget is first added to the layout. */
    defaultWidth: WidgetWidth;
    /** Hidden from the gallery on household (non-business) books. */
    businessOnly?: boolean;
}

function entry(
    id: BuiltinWidgetId,
    category: WidgetCategory,
    defaultWidth: WidgetWidth,
    businessOnly = false
): WidgetRegistryEntry {
    return {
        id,
        title: WIDGET_META[id].title,
        description: WIDGET_META[id].description,
        category,
        defaultWidth,
        businessOnly: businessOnly || undefined,
    };
}

export const WIDGET_REGISTRY: WidgetRegistryEntry[] = [
    entry('kpis', 'overview', 'full'),
    entry('netWorth', 'overview', 'full'),
    entry('cashFlow', 'overview', 'full'),
    entry('sankey', 'overview', 'full'),
    entry('incomePie', 'overview', 'third'),
    entry('expensePie', 'overview', 'third'),
    entry('taxPie', 'overview', 'third'),
    entry('goals', 'overview', 'third'),
    entry('budget-pacing', 'budgets', 'third'),
    entry('dividends', 'investments', 'third'),
    entry('ar-ap', 'business', 'third', true),
    entry('subscriptions', 'tools', 'third'),
    entry('data-health', 'tools', 'third'),
];

export function getRegistryEntry(id: string): WidgetRegistryEntry | undefined {
    return WIDGET_REGISTRY.find(e => e.id === id);
}

/** Registry entries visible in the gallery for the given book type. */
export function availableWidgets(opts: { isBusiness: boolean }): WidgetRegistryEntry[] {
    return WIDGET_REGISTRY.filter(e => !e.businessOnly || opts.isBusiness);
}

// Sanity: every builtin widget id must have a registry entry (checked in tests).
export function registryCoversAllWidgets(): boolean {
    const registered = new Set(WIDGET_REGISTRY.map(e => e.id));
    return ALL_WIDGET_IDS.every(id => registered.has(id));
}

/* ------------------------------------------------------------------ */
/* Custom widget definitions                                           */
/* ------------------------------------------------------------------ */

export type CustomWidgetMode = 'balance' | 'spend';

export const SPEND_DAYS_OPTIONS = [30, 90, 365] as const;
export type SpendDays = (typeof SPEND_DAYS_OPTIONS)[number];

/** Hard cap on accounts per custom widget (also enforced server-side). */
export const MAX_CUSTOM_WIDGET_ACCOUNTS = 20;
/** Hard cap on custom widget definitions per user. */
export const MAX_CUSTOM_WIDGETS = 30;

export interface CustomWidgetConfig {
    /**
     * balance: value = sum of the accounts' current balances (report currency).
     * spend:   value = sign-corrected activity total over the trailing window.
     */
    mode: CustomWidgetMode;
    accountGuids: string[];
    /** Trailing window; only meaningful for mode 'spend'. */
    days?: SpendDays;
    /** Color the stat green/red by the sign of the value. */
    toneBySign?: boolean;
}

export interface CustomWidgetDef {
    id: CustomWidgetId;
    name: string;
    config: CustomWidgetConfig;
    /** Display kind. v1 supports 'stat' only; charts are a future extension. */
    viz?: 'stat';
}

export function createCustomWidgetId(): CustomWidgetId {
    const uuid =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return `custom:${uuid}`;
}

/** Validate a single persisted custom-widget def. Returns null when unusable. */
export function validateCustomWidgetDef(value: unknown): CustomWidgetDef | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;

    const id = v.id;
    if (typeof id !== 'string' || !isCustomWidgetId(id)) return null;

    const name = typeof v.name === 'string' ? v.name.trim() : '';
    if (!name) return null;

    const config = v.config;
    if (!config || typeof config !== 'object') return null;
    const c = config as Record<string, unknown>;

    const mode = c.mode;
    if (mode !== 'balance' && mode !== 'spend') return null;

    const rawGuids = Array.isArray(c.accountGuids) ? c.accountGuids : null;
    if (!rawGuids) return null;
    const accountGuids = [
        ...new Set(rawGuids.filter((g): g is string => typeof g === 'string' && g.length > 0)),
    ].slice(0, MAX_CUSTOM_WIDGET_ACCOUNTS);
    if (accountGuids.length === 0) return null;

    const rawDays = typeof c.days === 'number' ? c.days : undefined;
    const days = SPEND_DAYS_OPTIONS.includes(rawDays as SpendDays)
        ? (rawDays as SpendDays)
        : mode === 'spend'
            ? 90
            : undefined;

    return {
        id,
        name: name.slice(0, 80),
        config: {
            mode,
            accountGuids,
            ...(mode === 'spend' ? { days } : {}),
            toneBySign: c.toneBySign === true,
        },
        viz: 'stat',
    };
}

/**
 * Validate the persisted `dashboard.customWidgets` value. Invalid entries and
 * duplicate ids are dropped; a non-array yields an empty list.
 */
export function sanitizeCustomWidgetDefs(value: unknown): CustomWidgetDef[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const defs: CustomWidgetDef[] = [];
    for (const item of value) {
        const def = validateCustomWidgetDef(item);
        if (!def || seen.has(def.id)) continue;
        seen.add(def.id);
        defs.push(def);
        if (defs.length >= MAX_CUSTOM_WIDGETS) break;
    }
    return defs;
}

/** Human-readable one-liner describing what a custom widget computes. */
export function describeCustomWidget(def: CustomWidgetDef): string {
    const n = def.config.accountGuids.length;
    const accounts = `${n} account${n === 1 ? '' : 's'}`;
    if (def.config.mode === 'balance') return `Balance of ${accounts}`;
    return `Spend across ${accounts}, last ${def.config.days ?? 90}d`;
}
