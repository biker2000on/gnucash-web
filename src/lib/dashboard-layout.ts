/**
 * Dashboard layout configuration.
 *
 * The dashboard is composed of widgets rendered from a user-configurable
 * layout (ordered list of widget id + width). The layout is persisted per
 * user in gnucash_web_user_preferences under the key `dashboard.layout`.
 */

export type WidgetId =
    | 'kpis'
    | 'netWorth'
    | 'sankey'
    | 'incomePie'
    | 'expensePie'
    | 'taxPie'
    | 'cashFlow';

export type WidgetWidth = 'full' | 'half' | 'third';

export interface WidgetLayoutItem {
    id: WidgetId;
    width: WidgetWidth;
}

export interface WidgetMeta {
    title: string;
    description: string;
}

export const WIDGET_META: Record<WidgetId, WidgetMeta> = {
    kpis: { title: 'KPI Cards', description: 'Net worth, income, expenses, savings rate, investments' },
    netWorth: { title: 'Net Worth Over Time', description: 'Assets, liabilities, and net worth time series' },
    sankey: { title: 'Income Flow', description: 'Sankey diagram of income and expense flows' },
    incomePie: { title: 'Income by Category', description: 'Income breakdown pie chart' },
    expensePie: { title: 'Expenses by Category', description: 'Expense breakdown pie chart' },
    taxPie: { title: 'Taxes by Category', description: 'Tax accounts breakdown pie chart' },
    cashFlow: { title: 'Cash Flow', description: 'Income vs expenses over time' },
};

export const ALL_WIDGET_IDS = Object.keys(WIDGET_META) as WidgetId[];

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
 */
export function sanitizeLayout(value: unknown): WidgetLayoutItem[] | null {
    if (!Array.isArray(value)) return null;
    const seen = new Set<WidgetId>();
    const layout: WidgetLayoutItem[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const id = (item as { id?: unknown }).id;
        const width = (item as { width?: unknown }).width;
        if (typeof id !== 'string' || !ALL_WIDGET_IDS.includes(id as WidgetId)) continue;
        if (seen.has(id as WidgetId)) continue;
        seen.add(id as WidgetId);
        layout.push({
            id: id as WidgetId,
            width: WIDTH_ORDER.includes(width as WidgetWidth) ? (width as WidgetWidth) : 'full',
        });
    }
    return layout.length > 0 ? layout : null;
}
