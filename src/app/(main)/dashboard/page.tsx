'use client';

import { useState, useEffect, useCallback, useMemo, useContext, useRef } from 'react';
import Link from 'next/link';
import KPIGrid from '@/components/dashboard/KPIGrid';
import NetWorthChart from '@/components/dashboard/NetWorthChart';
import SankeyDiagram, { SankeyHierarchyNode, SankeyResponseData } from '@/components/dashboard/SankeyDiagram';
import ExpensePieChart from '@/components/dashboard/ExpensePieChart';
import IncomePieChart from '@/components/dashboard/IncomePieChart';
import TaxPieChart from '@/components/dashboard/TaxPieChart';
import CashFlowChart from '@/components/charts/CashFlowChart';
import ExpandableChart, { ChartViewContext } from '@/components/charts/ExpandableChart';
import { DashboardPeriodProvider, useDashboardPeriod, PERIOD_OPTIONS } from '@/contexts/DashboardPeriodContext';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { DATE_PRESETS } from '@/lib/datePresets';
import { Modal } from '@/components/ui/Modal';
import NewBookForm from '@/components/books/NewBookForm';
import {
    WidgetId,
    WidgetLayoutItem,
    WIDGET_META,
    ALL_WIDGET_IDS,
    DEFAULT_LAYOUT,
    WIDTH_ORDER,
    WIDTH_CLASSES,
    sanitizeLayout,
} from '@/lib/dashboard-layout';

// ------------------------------------------------------------------
// Types matching API responses
// ------------------------------------------------------------------

interface KPIData {
    netWorth: number;
    netWorthChange: number;
    netWorthChangePercent: number;
    totalIncome: number;
    totalExpenses: number;
    savingsRate: number;
    topExpenseCategory: string;
    topExpenseAmount: number;
    investmentValue: number;
}

interface NetWorthDataPoint {
    date: string;
    netWorth: number;
    assets: number;
    liabilities: number;
}

interface CategoryData {
    name: string;
    value: number;
}

interface CashFlowData {
    month: string;
    income: number;
    expenses: number;
    netCashFlow: number;
}

interface CashFlowApiResponse {
    months?: string[];
    income?: number[];
    expenses?: number[];
    netCashFlow?: number[];
}

function cashFlowResponseToData(data: CashFlowApiResponse): CashFlowData[] {
    const months = data.months || [];
    const income = data.income || [];
    const expenses = data.expenses || [];
    const netCashFlow = data.netCashFlow || [];
    return months.map((month: string, index: number) => ({
        month,
        income: income[index] || 0,
        expenses: expenses[index] || 0,
        netCashFlow: netCashFlow[index] || 0,
    }));
}

// ------------------------------------------------------------------
// Derive pie chart data from sankey hierarchy tree
// ------------------------------------------------------------------

function deriveIncomeCategoriesFromTree(income: SankeyHierarchyNode[]): CategoryData[] {
    return income
        .filter(n => n.value > 0)
        .map(n => ({ name: n.name, value: n.value }))
        .sort((a, b) => b.value - a.value);
}

function deriveExpenseCategoriesFromTree(expense: SankeyHierarchyNode[]): CategoryData[] {
    return expense
        .filter(n => n.value > 0)
        .map(n => ({ name: n.name, value: n.value }))
        .sort((a, b) => b.value - a.value);
}

// Word-boundary match so "Taxes" and "Property Tax" match but "Taxi" doesn't.
const TAX_NAME_RE = /\btax(es)?\b/i;

/**
 * Collect tax expense categories from the sankey expense tree.
 *
 * When the user has tagged accounts with the "tax"/"taxes" tag, `taxGuids`
 * holds those accounts plus all their descendants and is the sole source of
 * truth. Otherwise we fall back to a word-boundary name match.
 */
function deriveTaxCategoriesFromTree(
    expense: SankeyHierarchyNode[],
    taxGuids: Set<string> | null
): CategoryData[] {
    const isTax: (node: SankeyHierarchyNode) => boolean =
        taxGuids && taxGuids.size > 0
            ? (node) => taxGuids.has(node.guid)
            : (node) => TAX_NAME_RE.test(node.name);

    const result: CategoryData[] = [];
    function collectTaxNodes(nodes: SankeyHierarchyNode[]) {
        for (const node of nodes) {
            if (isTax(node) && node.value > 0) {
                if (node.children.length > 0) {
                    // Parent tax node: expand into children instead of showing aggregate.
                    // Recursively apply the same logic to handle nested tax parents.
                    const childrenSum = node.children.reduce((s, c) => s + c.value, 0);
                    for (const child of node.children) {
                        if (child.value > 0) {
                            if (child.children.length > 0 && isTax(child)) {
                                // Nested tax parent — recurse
                                collectTaxNodes([child]);
                            } else {
                                result.push({ name: child.name, value: child.value });
                            }
                        }
                    }
                    // If parent has direct transactions beyond children, capture remainder
                    const remainder = Math.round((node.value - childrenSum) * 100) / 100;
                    if (remainder > 0.01) {
                        result.push({ name: `${node.name} (Other)`, value: remainder });
                    }
                } else {
                    // Leaf tax node (e.g. "Property Tax" under Home)
                    result.push({ name: node.name, value: node.value });
                }
            } else {
                // Non-tax node: recurse to find tax descendants
                collectTaxNodes(node.children);
            }
        }
    }
    collectTaxNodes(expense);
    return result.sort((a, b) => b.value - a.value);
}

// ------------------------------------------------------------------
// Expanded-view override fetching
// ------------------------------------------------------------------

/**
 * Fetch chart data for an expanded chart whose controls diverge from the
 * dashboard period. `url` is null while the chart should show the
 * dashboard-level data (collapsed, or controls match the dashboard).
 */
function useOverrideFetch<T>(url: string | null): { data: T | null; loading: boolean } {
    const [data, setData] = useState<T | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!url) {
            setData(null);
            setLoading(false);
            return;
        }
        let cancelled = false;
        setLoading(true);
        fetch(url)
            .then(res => (res.ok ? res.json() : null))
            .then(json => {
                if (!cancelled) setData(json);
            })
            .catch(() => {
                if (!cancelled) setData(null);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [url]);

    return { data, loading };
}

/** Build an override URL when the expanded view differs from the dashboard period. */
function buildOverrideUrl(
    endpoint: string,
    view: { startDate: string | null; endDate: string | null; groupBy: string } | null,
    base: { startDate: string | null; endDate: string | null },
    supportsGroupBy: boolean
): string | null {
    if (!view) return null;
    const matchesBase =
        view.startDate === base.startDate &&
        view.endDate === base.endDate &&
        (!supportsGroupBy || view.groupBy === 'month');
    if (matchesBase) return null;
    const params = new URLSearchParams();
    if (view.startDate) params.set('startDate', view.startDate);
    if (view.endDate) params.set('endDate', view.endDate);
    if (supportsGroupBy) params.set('groupBy', view.groupBy);
    const qs = params.toString();
    return qs ? `${endpoint}?${qs}` : endpoint;
}

// ------------------------------------------------------------------
// Widget content components (react to expanded-view controls)
// ------------------------------------------------------------------

function NetWorthWidget({ baseData, baseLoading }: { baseData: NetWorthDataPoint[]; baseLoading: boolean }) {
    const view = useContext(ChartViewContext);
    const { startDate, endDate } = useDashboardPeriod();
    const url = buildOverrideUrl('/api/dashboard/net-worth', view, { startDate, endDate }, true);
    const { data, loading } = useOverrideFetch<{ timeSeries?: NetWorthDataPoint[] }>(url);

    if (url) {
        return <NetWorthChart data={data?.timeSeries || []} loading={loading} />;
    }
    return <NetWorthChart data={baseData} loading={baseLoading} />;
}

function CashFlowWidget({ baseData, baseLoading }: { baseData: CashFlowData[]; baseLoading: boolean }) {
    const view = useContext(ChartViewContext);
    const { startDate, endDate } = useDashboardPeriod();
    const url = buildOverrideUrl('/api/dashboard/cash-flow-chart', view, { startDate, endDate }, true);
    const { data, loading } = useOverrideFetch<CashFlowApiResponse>(url);

    if (url) {
        return <CashFlowChart data={data ? cashFlowResponseToData(data) : []} loading={loading} />;
    }
    return <CashFlowChart data={baseData} loading={baseLoading} />;
}

function SankeyWidget({ baseData, baseLoading }: { baseData: SankeyResponseData | null; baseLoading: boolean }) {
    const view = useContext(ChartViewContext);
    const { startDate, endDate } = useDashboardPeriod();
    const url = buildOverrideUrl('/api/dashboard/sankey', view, { startDate, endDate }, false);
    const { data, loading } = useOverrideFetch<SankeyResponseData>(url);

    if (url) {
        return <SankeyDiagram data={data} loading={loading} />;
    }
    return <SankeyDiagram data={baseData} loading={baseLoading} />;
}

function PieWidget({
    kind,
    baseSankey,
    baseLoading,
    taxGuids,
}: {
    kind: 'income' | 'expense' | 'tax';
    baseSankey: SankeyResponseData | null;
    baseLoading: boolean;
    taxGuids: Set<string> | null;
}) {
    const view = useContext(ChartViewContext);
    const { startDate, endDate } = useDashboardPeriod();
    const url = buildOverrideUrl('/api/dashboard/sankey', view, { startDate, endDate }, false);
    const { data, loading } = useOverrideFetch<SankeyResponseData>(url);

    const sankey = url ? data : baseSankey;
    const isLoading = url ? loading : baseLoading;

    const categories = useMemo(() => {
        if (!sankey) return [];
        if (kind === 'income') return deriveIncomeCategoriesFromTree(sankey.income);
        if (kind === 'expense') return deriveExpenseCategoriesFromTree(sankey.expense);
        return deriveTaxCategoriesFromTree(sankey.expense, taxGuids);
    }, [sankey, kind, taxGuids]);

    if (kind === 'income') return <IncomePieChart data={categories} loading={isLoading} />;
    if (kind === 'expense') return <ExpensePieChart data={categories} loading={isLoading} />;
    return <TaxPieChart data={categories} loading={isLoading} taggedMode={!!taxGuids && taxGuids.size > 0} />;
}

// ------------------------------------------------------------------
// Dashboard content (uses period context)
// ------------------------------------------------------------------

function DashboardContent() {
    const { period, setPeriod, startDate, endDate, queryString } = useDashboardPeriod();
    const { dashboardDefaultPeriod, setDashboardDefaultPeriod } = useUserPreferences();

    // Data states
    const [kpiData, setKpiData] = useState<KPIData | null>(null);
    const [netWorthData, setNetWorthData] = useState<NetWorthDataPoint[]>([]);
    const [sankeyData, setSankeyData] = useState<SankeyResponseData | null>(null);
    const [cashFlowData, setCashFlowData] = useState<CashFlowData[]>([]);
    const [taxGuids, setTaxGuids] = useState<Set<string> | null>(null);

    // Loading states
    const [kpiLoading, setKpiLoading] = useState(true);
    const [netWorthLoading, setNetWorthLoading] = useState(true);
    const [sankeyLoading, setSankeyLoading] = useState(true);
    const [cashFlowLoading, setCashFlowLoading] = useState(true);

    // Layout states
    const [layout, setLayout] = useState<WidgetLayoutItem[]>(DEFAULT_LAYOUT);
    const [layoutLoaded, setLayoutLoaded] = useState(false);
    const [editing, setEditing] = useState(false);
    const dragIndexRef = useRef<number | null>(null);

    // Fetch KPIs
    const fetchKpis = useCallback(async (qs: string) => {
        setKpiLoading(true);
        try {
            const res = await fetch(`/api/dashboard/kpis${qs}`);
            if (res.ok) {
                const data = await res.json();
                setKpiData(data);
            }
        } catch {
            // silently fail, show empty state
        } finally {
            setKpiLoading(false);
        }
    }, []);

    // Fetch net worth
    const fetchNetWorth = useCallback(async (qs: string) => {
        setNetWorthLoading(true);
        try {
            const res = await fetch(`/api/dashboard/net-worth${qs}`);
            if (res.ok) {
                const data = await res.json();
                setNetWorthData(data.timeSeries || []);
            }
        } catch {
            // silently fail
        } finally {
            setNetWorthLoading(false);
        }
    }, []);

    // Fetch sankey
    const fetchSankey = useCallback(async (qs: string) => {
        setSankeyLoading(true);
        try {
            const res = await fetch(`/api/dashboard/sankey${qs}`);
            if (res.ok) {
                const data = await res.json();
                setSankeyData(data);
            }
        } catch {
            // silently fail
        } finally {
            setSankeyLoading(false);
        }
    }, []);

    // Fetch cash flow
    const fetchCashFlow = useCallback(async (qs: string) => {
        setCashFlowLoading(true);
        try {
            const res = await fetch(`/api/dashboard/cash-flow-chart${qs}`);
            if (res.ok) {
                const data = await res.json();
                setCashFlowData(cashFlowResponseToData(data));
            }
        } catch {
            // silently fail
        } finally {
            setCashFlowLoading(false);
        }
    }, []);

    // Fetch tax account guids (tag-driven; not period dependent)
    useEffect(() => {
        let cancelled = false;
        fetch('/api/dashboard/tax-accounts')
            .then(res => (res.ok ? res.json() : null))
            .then(json => {
                if (cancelled || !json) return;
                setTaxGuids(json.tagged ? new Set<string>(json.guids) : null);
            })
            .catch(() => {
                // fall back to name matching
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // Load persisted dashboard layout
    useEffect(() => {
        let cancelled = false;
        fetch('/api/user/preferences?key=dashboard.layout')
            .then(res => (res.ok ? res.json() : null))
            .then(json => {
                if (cancelled) return;
                const stored = sanitizeLayout(json?.preferences?.['dashboard.layout']);
                if (stored) setLayout(stored);
            })
            .catch(() => {
                // keep default layout
            })
            .finally(() => {
                if (!cancelled) setLayoutLoaded(true);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const persistLayout = useCallback((next: WidgetLayoutItem[]) => {
        fetch('/api/user/preferences', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ preferences: { 'dashboard.layout': next } }),
        }).catch(() => {
            // non-fatal; layout still applies locally
        });
    }, []);

    const updateLayout = useCallback((next: WidgetLayoutItem[]) => {
        setLayout(next);
        persistLayout(next);
    }, [persistLayout]);

    // Fetch all data when query string changes
    useEffect(() => {
        fetchKpis(queryString);
        fetchNetWorth(queryString);
        fetchSankey(queryString);
        fetchCashFlow(queryString);
    }, [queryString, fetchKpis, fetchNetWorth, fetchSankey, fetchCashFlow]);

    // ------------------------------------------------------------------
    // Layout editing actions
    // ------------------------------------------------------------------

    const hiddenWidgets = useMemo(
        () => ALL_WIDGET_IDS.filter(id => !layout.some(item => item.id === id)),
        [layout]
    );

    const cycleWidth = (index: number) => {
        const next = layout.map((item, i) => {
            if (i !== index) return item;
            const pos = WIDTH_ORDER.indexOf(item.width);
            return { ...item, width: WIDTH_ORDER[(pos + 1) % WIDTH_ORDER.length] };
        });
        updateLayout(next);
    };

    const removeWidget = (index: number) => {
        updateLayout(layout.filter((_, i) => i !== index));
    };

    const addWidget = (id: WidgetId) => {
        const defaultItem = DEFAULT_LAYOUT.find(item => item.id === id);
        updateLayout([...layout, { id, width: defaultItem?.width ?? 'full' }]);
    };

    const moveWidget = (from: number, to: number) => {
        if (from === to || from < 0 || to < 0 || from >= layout.length || to >= layout.length) return;
        const next = [...layout];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        setLayout(next);
    };

    const handleDragStart = (index: number) => {
        dragIndexRef.current = index;
    };

    const handleDragOver = (e: React.DragEvent, index: number) => {
        e.preventDefault();
        const from = dragIndexRef.current;
        if (from === null || from === index) return;
        moveWidget(from, index);
        dragIndexRef.current = index;
    };

    const handleDragEnd = () => {
        dragIndexRef.current = null;
        persistLayout(layout);
    };

    // ------------------------------------------------------------------
    // Widget rendering
    // ------------------------------------------------------------------

    const renderWidget = (id: WidgetId) => {
        switch (id) {
            case 'kpis':
                return <KPIGrid data={kpiData} loading={kpiLoading} />;
            case 'netWorth':
                return (
                    <ExpandableChart
                        title="Net Worth Over Time"
                        controls="period-group"
                        initialStartDate={startDate}
                        initialEndDate={endDate}
                    >
                        <NetWorthWidget baseData={netWorthData} baseLoading={netWorthLoading} />
                    </ExpandableChart>
                );
            case 'sankey':
                return (
                    <ExpandableChart
                        title="Income Flow"
                        controls="period"
                        initialStartDate={startDate}
                        initialEndDate={endDate}
                    >
                        <SankeyWidget baseData={sankeyData} baseLoading={sankeyLoading} />
                    </ExpandableChart>
                );
            case 'incomePie':
                return (
                    <ExpandableChart
                        title="Income by Category"
                        controls="period"
                        initialStartDate={startDate}
                        initialEndDate={endDate}
                    >
                        <PieWidget kind="income" baseSankey={sankeyData} baseLoading={sankeyLoading} taxGuids={taxGuids} />
                    </ExpandableChart>
                );
            case 'expensePie':
                return (
                    <ExpandableChart
                        title="Expenses by Category"
                        controls="period"
                        initialStartDate={startDate}
                        initialEndDate={endDate}
                    >
                        <PieWidget kind="expense" baseSankey={sankeyData} baseLoading={sankeyLoading} taxGuids={taxGuids} />
                    </ExpandableChart>
                );
            case 'taxPie':
                return (
                    <ExpandableChart
                        title="Taxes by Category"
                        controls="period"
                        initialStartDate={startDate}
                        initialEndDate={endDate}
                    >
                        <PieWidget kind="tax" baseSankey={sankeyData} baseLoading={sankeyLoading} taxGuids={taxGuids} />
                    </ExpandableChart>
                );
            case 'cashFlow':
                return (
                    <ExpandableChart
                        title="Cash Flow"
                        controls="period-group"
                        initialStartDate={startDate}
                        initialEndDate={endDate}
                    >
                        <CashFlowWidget baseData={cashFlowData} baseLoading={cashFlowLoading} />
                    </ExpandableChart>
                );
        }
    };

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
                    <p className="text-sm text-foreground-secondary mt-1">
                        Your financial overview at a glance
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <DateRangePicker
                        startDate={startDate}
                        endDate={endDate}
                        onChange={(range) => {
                            // Match against named periods
                            for (const opt of PERIOD_OPTIONS) {
                                const preset = DATE_PRESETS.find(p => p.label === opt.label);
                                if (preset) {
                                    const pv = preset.getValue();
                                    if (pv.startDate === range.startDate && pv.endDate === range.endDate) {
                                        setPeriod(opt.key);
                                        return;
                                    }
                                }
                            }
                            setPeriod('allTime');
                        }}
                    />
                    {period !== dashboardDefaultPeriod && (
                        <button
                            onClick={() => setDashboardDefaultPeriod(period)}
                            title="Save as default period"
                            className="p-1.5 rounded-md text-foreground-secondary hover:text-amber-500 hover:bg-surface-hover transition-colors"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
                            </svg>
                        </button>
                    )}
                    <button
                        onClick={() => setEditing(e => !e)}
                        title={editing ? 'Done customizing' : 'Customize dashboard'}
                        className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-sm transition-colors ${
                            editing
                                ? 'border-primary/50 bg-primary/10 text-primary'
                                : 'border-border bg-surface/50 text-foreground-secondary hover:border-primary/50'
                        }`}
                    >
                        {editing ? (
                            <>Done</>
                        ) : (
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
                            </svg>
                        )}
                        {!editing && <span className="hidden sm:inline">Customize</span>}
                    </button>
                </div>
            </div>

            {/* Edit mode toolbar */}
            {editing && (
                <div className="flex flex-wrap items-center gap-3 bg-surface border border-border rounded-xl px-4 py-3">
                    <span className="text-sm text-foreground-secondary">
                        Drag widgets to rearrange. Use the buttons on each widget to resize or remove it.
                    </span>
                    {hiddenWidgets.length > 0 && (
                        <div className="flex flex-wrap items-center gap-2">
                            {hiddenWidgets.map(id => (
                                <button
                                    key={id}
                                    onClick={() => addWidget(id)}
                                    title={WIDGET_META[id].description}
                                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-dashed border-border text-xs text-foreground-secondary hover:border-primary/50 hover:text-primary transition-colors"
                                >
                                    <span aria-hidden>+</span> {WIDGET_META[id].title}
                                </button>
                            ))}
                        </div>
                    )}
                    <button
                        onClick={() => updateLayout(DEFAULT_LAYOUT)}
                        className="ml-auto px-2.5 py-1 rounded-lg text-xs text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors"
                    >
                        Reset to default
                    </button>
                </div>
            )}

            {/* Widget grid */}
            <div className={`grid grid-cols-1 lg:grid-cols-6 gap-6 ${layoutLoaded ? '' : 'opacity-90'}`}>
                {layout.map((item, index) => (
                    <div
                        key={item.id}
                        className={`${WIDTH_CLASSES[item.width]} ${
                            editing ? 'relative rounded-xl ring-1 ring-primary/30 cursor-grab active:cursor-grabbing' : ''
                        }`}
                        draggable={editing}
                        onDragStart={editing ? () => handleDragStart(index) : undefined}
                        onDragOver={editing ? (e) => handleDragOver(e, index) : undefined}
                        onDragEnd={editing ? handleDragEnd : undefined}
                    >
                        {editing && (
                            <div className="absolute -top-3 right-3 z-20 flex items-center gap-1">
                                <button
                                    onClick={() => cycleWidth(index)}
                                    title={`Width: ${item.width} (click to change)`}
                                    className="px-2 py-0.5 rounded-md bg-surface border border-border text-xs text-foreground-secondary hover:text-primary hover:border-primary/50 transition-colors"
                                >
                                    {item.width}
                                </button>
                                <button
                                    onClick={() => removeWidget(index)}
                                    title="Remove widget"
                                    className="px-2 py-0.5 rounded-md bg-surface border border-border text-xs text-foreground-secondary hover:text-negative hover:border-negative/50 transition-colors"
                                >
                                    ✕
                                </button>
                            </div>
                        )}
                        <div className={editing ? 'pointer-events-none' : ''}>
                            {renderWidget(item.id)}
                        </div>
                    </div>
                ))}
            </div>

            {layout.length === 0 && (
                <div className="bg-surface border border-border rounded-xl p-10 text-center">
                    <p className="text-foreground-secondary text-sm">
                        All widgets are hidden. {editing ? 'Add widgets from the toolbar above.' : 'Click Customize to add widgets.'}
                    </p>
                </div>
            )}
        </div>
    );
}

// ------------------------------------------------------------------
// Dashboard page (book check + provider wrapper)
// ------------------------------------------------------------------

export default function DashboardPage() {
    // Book states
    const [hasBooks, setHasBooks] = useState(true);
    const [newBookOpen, setNewBookOpen] = useState(false);
    const [checkingBooks, setCheckingBooks] = useState(true);

    // Check if books exist
    useEffect(() => {
        async function checkBooks() {
            setCheckingBooks(true);
            try {
                const res = await fetch('/api/books');
                if (res.ok) {
                    const books = await res.json();
                    setHasBooks(books.length > 0);
                }
            } catch {
                // If we can't fetch books, assume they exist to show dashboard
                setHasBooks(true);
            } finally {
                setCheckingBooks(false);
            }
        }
        checkBooks();
    }, []);

    const handleBookCreated = async (bookGuid: string) => {
        try {
            // Switch to new book
            await fetch('/api/books/active', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bookGuid }),
            });
        } catch (err) {
            console.error('Error switching to new book:', err);
        }
        // Reload to show dashboard with new book
        window.location.reload();
    };

    // Show welcome screen if no books exist
    if (checkingBooks) {
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <div className="text-foreground-secondary">Loading...</div>
            </div>
        );
    }

    if (!hasBooks) {
        return (
            <div className="min-h-[60vh] flex flex-col items-center justify-center p-8">
                <h1 className="text-3xl font-bold text-foreground mb-2">Welcome to GnuCash Web</h1>
                <p className="text-foreground-secondary mb-8">Get started by creating a new book or importing an existing one.</p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-2xl w-full">
                    {/* Create New Book Card */}
                    <button
                        onClick={() => setNewBookOpen(true)}
                        className="bg-surface border border-border rounded-xl p-6 text-left hover:border-primary/50 transition-colors group"
                    >
                        <div className="flex items-center gap-3 mb-3">
                            <div className="flex items-center justify-center w-10 h-10 bg-primary/10 rounded-lg group-hover:bg-primary/20 transition-colors">
                                <svg className="w-5 h-5 text-primary" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m6-6H6" />
                                </svg>
                            </div>
                            <h3 className="text-lg font-semibold text-foreground">Create New Book</h3>
                        </div>
                        <p className="text-sm text-foreground-secondary">
                            Pick your organization type — household, business, or nonprofit — and start with a recommended account hierarchy.
                        </p>
                    </button>

                    {/* Import Card */}
                    <Link href="/import-export" className="bg-surface border border-border rounded-xl p-6 text-left hover:border-primary/50 transition-colors group">
                        <div className="flex items-center gap-3 mb-3">
                            <div className="flex items-center justify-center w-10 h-10 bg-primary/10 rounded-lg group-hover:bg-primary/20 transition-colors">
                                <svg className="w-5 h-5 text-primary" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                                </svg>
                            </div>
                            <h3 className="text-lg font-semibold text-foreground">Import GnuCash File</h3>
                        </div>
                        <p className="text-sm text-foreground-secondary">
                            Import your existing GnuCash SQLite or XML file to view your financial data in the web interface.
                        </p>
                    </Link>
                </div>

                <Modal isOpen={newBookOpen} onClose={() => setNewBookOpen(false)} title="Create New Book" size="lg">
                    <div className="p-6">
                        <NewBookForm
                            onSuccess={handleBookCreated}
                            onCancel={() => setNewBookOpen(false)}
                        />
                    </div>
                </Modal>
            </div>
        );
    }

    return (
        <DashboardPeriodProvider>
            <DashboardContent />
        </DashboardPeriodProvider>
    );
}
