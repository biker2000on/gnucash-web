/**
 * Dashboard widget registry + custom widget definitions.
 *
 * Pure module (no React) so registry filtering and custom-def validation are
 * unit-testable. Rendering lives in src/components/dashboard/widgets/ and is
 * wired up in src/app/(main)/dashboard/page.tsx.
 *
 * Persistence keys (gnucash_web_user_preferences, per user, per book):
 *   - `dashboard.layout.<bookGuid>`        ordered [{ id, width }] (see dashboard-layout.ts)
 *   - `dashboard.customWidgets.<bookGuid>` array of CustomWidgetDef
 *
 * Legacy (pre-per-book) keys `dashboard.layout` / `dashboard.customWidgets`
 * are read as a one-time fallback seed when a book has no per-book value yet;
 * all writes go to the per-book keys. See resolveDashboardKeys().
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
/* Per-book preference keys                                            */
/* ------------------------------------------------------------------ */

export interface DashboardPrefKeys {
    /** Per-book key all saves are written to (legacy key when no bookGuid). */
    layoutKey: string;
    customWidgetsKey: string;
    /** Legacy global keys, read-only fallback for first load on a book. */
    legacyLayoutKey: string;
    legacyCustomWidgetsKey: string;
}

/**
 * Resolve the preference keys for the given active book.
 *
 * With a bookGuid the per-book keys are `dashboard.layout.<bookGuid>` /
 * `dashboard.customWidgets.<bookGuid>`. Without one (books/active failed or
 * returned nothing) the per-book keys degrade to the legacy global keys so
 * saves still land somewhere sensible.
 */
export function resolveDashboardKeys(bookGuid: string | null | undefined): DashboardPrefKeys {
    const guid = typeof bookGuid === 'string' ? bookGuid.trim() : '';
    const suffix = guid ? `.${guid}` : '';
    return {
        layoutKey: `${LAYOUT_PREF_KEY}${suffix}`,
        customWidgetsKey: `${CUSTOM_WIDGETS_PREF_KEY}${suffix}`,
        legacyLayoutKey: LAYOUT_PREF_KEY,
        legacyCustomWidgetsKey: CUSTOM_WIDGETS_PREF_KEY,
    };
}

/**
 * Pick the effective raw preference value: the per-book key wins when it holds
 * a value; otherwise the legacy global key acts as the starting value (a
 * one-time seed — the first save writes it to the per-book key and legacy is
 * never consulted again for this book).
 */
export function pickDashboardPref(
    prefs: Record<string, unknown> | null | undefined,
    perBookKey: string,
    legacyKey: string
): unknown {
    if (!prefs || typeof prefs !== 'object') return undefined;
    const perBook = prefs[perBookKey];
    if (perBook !== undefined && perBook !== null) return perBook;
    if (perBookKey === legacyKey) return undefined;
    return prefs[legacyKey];
}

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
    entry('insights', 'overview', 'third'),
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

/**
 * Display kind for a custom widget.
 *   stat  — single big number (v1 behavior).
 *   spark — line sparkline over a monthly time series.
 *   bar   — monthly bars over the same series.
 */
export type CustomWidgetViz = 'stat' | 'spark' | 'bar';

export const CUSTOM_WIDGET_VIZ_OPTIONS = ['stat', 'spark', 'bar'] as const;

export function isChartViz(viz: CustomWidgetViz | undefined): viz is 'spark' | 'bar' {
    return viz === 'spark' || viz === 'bar';
}

export const SPEND_DAYS_OPTIONS = [30, 90, 365] as const;
export type SpendDays = (typeof SPEND_DAYS_OPTIONS)[number];

/** Trailing-window options (in months) for chart-type custom widgets. */
export const SERIES_MONTHS_OPTIONS = [6, 12, 24] as const;
export type SeriesMonths = (typeof SERIES_MONTHS_OPTIONS)[number];
export const DEFAULT_SERIES_MONTHS: SeriesMonths = 12;

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
    /** Trailing window; only meaningful for mode 'spend' with viz 'stat'. */
    days?: SpendDays;
    /** Time-series window; only meaningful for chart viz ('spark' | 'bar'). */
    months?: SeriesMonths;
    /** Color the stat green/red by the sign of the value (viz 'stat' only). */
    toneBySign?: boolean;
}

export interface CustomWidgetDef {
    id: CustomWidgetId;
    name: string;
    config: CustomWidgetConfig;
    /**
     * Display kind. Defs persisted before charts existed have no `viz` and
     * are normalized to 'stat' (backward compat).
     */
    viz?: CustomWidgetViz;
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

    // Backward compat: defs persisted before charts have no viz → 'stat'.
    // Unknown future values also degrade to 'stat' rather than dropping the def.
    const viz: CustomWidgetViz = CUSTOM_WIDGET_VIZ_OPTIONS.includes(
        v.viz as CustomWidgetViz
    )
        ? (v.viz as CustomWidgetViz)
        : 'stat';

    const rawDays = typeof c.days === 'number' ? c.days : undefined;
    const days = SPEND_DAYS_OPTIONS.includes(rawDays as SpendDays)
        ? (rawDays as SpendDays)
        : mode === 'spend'
            ? 90
            : undefined;

    const rawMonths = typeof c.months === 'number' ? c.months : undefined;
    const months: SeriesMonths = SERIES_MONTHS_OPTIONS.includes(rawMonths as SeriesMonths)
        ? (rawMonths as SeriesMonths)
        : DEFAULT_SERIES_MONTHS;

    return {
        id,
        name: name.slice(0, 80),
        config: {
            mode,
            accountGuids,
            ...(mode === 'spend' && viz === 'stat' ? { days } : {}),
            ...(isChartViz(viz) ? { months } : {}),
            toneBySign: c.toneBySign === true,
        },
        viz,
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
    if (isChartViz(def.viz)) {
        const months = def.config.months ?? DEFAULT_SERIES_MONTHS;
        return def.config.mode === 'balance'
            ? `Balance of ${accounts}, monthly, ${months}mo`
            : `Monthly spend across ${accounts}, ${months}mo`;
    }
    if (def.config.mode === 'balance') return `Balance of ${accounts}`;
    return `Spend across ${accounts}, last ${def.config.days ?? 90}d`;
}
