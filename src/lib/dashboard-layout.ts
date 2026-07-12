/**
 * Dashboard layout configuration.
 *
 * The dashboard is composed of widgets rendered from a user-configurable
 * layout (ordered list of widget id + width). The layout is persisted per
 * user in gnucash_web_user_preferences under the key `dashboard.layout`.
 *
 * Widget ids are either built-in (see BuiltinWidgetId) or user-defined
 * custom widgets with a `custom:<uuid>` id, whose definitions are persisted
 * under `dashboard.customWidgets` (see dashboard-widgets.ts).
 */

export type BuiltinWidgetId =
    | 'kpis'
    | 'netWorth'
    | 'sankey'
    | 'incomePie'
    | 'expensePie'
    | 'taxPie'
    | 'cashFlow'
    | 'goals'
    | 'budget-pacing'
    | 'ar-ap'
    | 'dividends'
    | 'subscriptions'
    | 'data-health'
    | 'insights';

export type CustomWidgetId = `custom:${string}`;

export type WidgetId = BuiltinWidgetId | CustomWidgetId;

export function isCustomWidgetId(id: string): id is CustomWidgetId {
    return id.startsWith('custom:') && id.length > 'custom:'.length;
}

export type WidgetWidth = 'full' | 'half' | 'third';

export interface WidgetLayoutItem {
    id: WidgetId;
    width: WidgetWidth;
}

export interface WidgetMeta {
    title: string;
    description: string;
}

export const WIDGET_META: Record<BuiltinWidgetId, WidgetMeta> = {
    kpis: { title: 'KPI Cards', description: 'Net worth, income, expenses, savings rate, investments' },
    netWorth: { title: 'Net Worth Over Time', description: 'Assets, liabilities, and net worth time series' },
    sankey: { title: 'Income Flow', description: 'Sankey diagram of income and expense flows' },
    incomePie: { title: 'Income by Category', description: 'Income breakdown pie chart' },
    expensePie: { title: 'Expenses by Category', description: 'Expense breakdown pie chart' },
    taxPie: { title: 'Taxes by Category', description: 'Tax accounts breakdown pie chart' },
    cashFlow: { title: 'Cash Flow', description: 'Income vs expenses over time' },
    goals: { title: 'Goals', description: 'Top savings and payoff goals with progress bars' },
    'budget-pacing': { title: 'Budget Pacing', description: 'Current-period spending pace for your active budget' },
    'ar-ap': { title: 'AR / AP', description: 'Outstanding receivables and payables due' },
    dividends: { title: 'Dividend Income', description: 'Trailing-12-month and projected dividend income' },
    subscriptions: { title: 'Subscriptions', description: 'Detected recurring charges and monthly total' },
    'data-health': { title: 'Data Health', description: 'Book data quality score and grade' },
    insights: { title: 'Insights', description: 'Proactive alerts: spending spikes, new merchants, milestones' },
};

export const ALL_WIDGET_IDS = Object.keys(WIDGET_META) as BuiltinWidgetId[];

/**
 * Default layout. Intentionally unchanged from before composable widgets
 * shipped so existing users (and users with no saved layout) see the same
 * default set.
 */
export const DEFAULT_LAYOUT: WidgetLayoutItem[] = [
    { id: 'kpis', width: 'full' },
    { id: 'netWorth', width: 'full' },
    { id: 'sankey', width: 'full' },
    { id: 'incomePie', width: 'third' },
    { id: 'expensePie', width: 'third' },
    { id: 'taxPie', width: 'third' },
    { id: 'cashFlow', width: 'full' },
];

export const WIDTH_ORDER: WidgetWidth[] = ['full', 'half', 'third'];

/** Tailwind col-span classes for each width on the lg 6-column dashboard grid. */
export const WIDTH_CLASSES: Record<WidgetWidth, string> = {
    full: 'lg:col-span-6',
    half: 'lg:col-span-3',
    third: 'lg:col-span-2',
};

/**
 * Validate and normalize a persisted layout value. Returns null when the
 * value is unusable (fall back to DEFAULT_LAYOUT).
 *
 * `knownCustomIds` is the set of `custom:<uuid>` ids that have a persisted
 * custom-widget definition; custom ids in the saved layout that no longer
 * have a definition are dropped gracefully.
 */
export function sanitizeLayout(
    value: unknown,
    knownCustomIds?: Iterable<string>
): WidgetLayoutItem[] | null {
    if (!Array.isArray(value)) return null;
    const customIds = new Set<string>(knownCustomIds ?? []);
    const seen = new Set<string>();
    const layout: WidgetLayoutItem[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const id = (item as { id?: unknown }).id;
        const width = (item as { width?: unknown }).width;
        if (typeof id !== 'string') continue;
        const isBuiltin = ALL_WIDGET_IDS.includes(id as BuiltinWidgetId);
        const isKnownCustom = isCustomWidgetId(id) && customIds.has(id);
        if (!isBuiltin && !isKnownCustom) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        layout.push({
            id: id as WidgetId,
            width: WIDTH_ORDER.includes(width as WidgetWidth) ? (width as WidgetWidth) : 'full',
        });
    }
    return layout.length > 0 ? layout : null;
}
