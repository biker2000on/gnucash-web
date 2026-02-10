'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { DateRange } from '@/lib/datePresets';
import KPIGrid from '@/components/dashboard/KPIGrid';
import NetWorthChart from '@/components/dashboard/NetWorthChart';
import SankeyDiagram, { SankeyHierarchyNode, SankeyResponseData } from '@/components/dashboard/SankeyDiagram';
import ExpensePieChart from '@/components/dashboard/ExpensePieChart';
import IncomePieChart from '@/components/dashboard/IncomePieChart';
import TaxPieChart from '@/components/dashboard/TaxPieChart';
import IncomeExpenseBarChart from '@/components/dashboard/IncomeExpenseBarChart';
import NetProfitChart from '@/components/dashboard/NetProfitChart';
import ExpandableChart from '@/components/charts/ExpandableChart';

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

interface MonthlyData {
    month: string;
    income: number;
    expenses: number;
    taxes: number;
    netProfit: number;
}

interface CategoryData {
    name: string;
    value: number;
}

// ------------------------------------------------------------------
// Helper: year-to-date default range
// ------------------------------------------------------------------

function getYearToDateRange(): DateRange {
    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    return {
        startDate: startOfYear.toISOString().split('T')[0],
        endDate: now.toISOString().split('T')[0],
    };
}

function buildQueryString(startDate: string | null, endDate: string | null): string {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    const qs = params.toString();
    return qs ? `?${qs}` : '';
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

function deriveTaxCategoriesFromTree(expense: SankeyHierarchyNode[]): CategoryData[] {
    const result: CategoryData[] = [];
    function collectTaxNodes(nodes: SankeyHierarchyNode[]) {
        for (const node of nodes) {
            if (node.name.toLowerCase().includes('tax') && node.value > 0) {
                if (node.children.length > 0) {
                    // Parent tax node: expand into children instead of showing aggregate.
                    // Recursively apply the same logic to handle nested tax parents.
                    const childrenSum = node.children.reduce((s, c) => s + c.value, 0);
                    for (const child of node.children) {
                        if (child.value > 0) {
                            if (child.children.length > 0 && child.name.toLowerCase().includes('tax')) {
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
// Dashboard page
// ------------------------------------------------------------------

export default function DashboardPage() {
    const [dateRange, setDateRange] = useState<DateRange>(getYearToDateRange);

    // Book states
    const [hasBooks, setHasBooks] = useState(true);
    const [creatingBook, setCreatingBook] = useState(false);
    const [checkingBooks, setCheckingBooks] = useState(true);

    // Data states
    const [kpiData, setKpiData] = useState<KPIData | null>(null);
    const [netWorthData, setNetWorthData] = useState<NetWorthDataPoint[]>([]);
    const [monthlyData, setMonthlyData] = useState<MonthlyData[]>([]);
    const [sankeyData, setSankeyData] = useState<SankeyResponseData | null>(null);

    // Loading states
    const [kpiLoading, setKpiLoading] = useState(true);
    const [netWorthLoading, setNetWorthLoading] = useState(true);
    const [monthlyLoading, setMonthlyLoading] = useState(true);
    const [sankeyLoading, setSankeyLoading] = useState(true);

    const queryString = useMemo(
        () => buildQueryString(dateRange.startDate, dateRange.endDate),
        [dateRange.startDate, dateRange.endDate]
    );

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

    // Fetch income/expense monthly
    const fetchIncomeExpense = useCallback(async (qs: string) => {
        setMonthlyLoading(true);
        try {
            const res = await fetch(`/api/dashboard/income-expense${qs}`);
            if (res.ok) {
                const data = await res.json();
                setMonthlyData(data.monthly || []);
            }
        } catch {
            // silently fail
        } finally {
            setMonthlyLoading(false);
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

    // Fetch all data when query string changes
    useEffect(() => {
        if (!hasBooks || checkingBooks) return;
        fetchKpis(queryString);
        fetchNetWorth(queryString);
        fetchIncomeExpense(queryString);
        fetchSankey(queryString);
    }, [queryString, hasBooks, checkingBooks, fetchKpis, fetchNetWorth, fetchIncomeExpense, fetchSankey]);

    // Derive pie chart data from sankey hierarchy
    const incomeCategories = useMemo(
        () => sankeyData ? deriveIncomeCategoriesFromTree(sankeyData.income) : [],
        [sankeyData]
    );
    const expenseCategories = useMemo(
        () => sankeyData ? deriveExpenseCategoriesFromTree(sankeyData.expense) : [],
        [sankeyData]
    );
    const taxCategories = useMemo(
        () => sankeyData ? deriveTaxCategoriesFromTree(sankeyData.expense) : [],
        [sankeyData]
    );

    const handleDateChange = useCallback((range: DateRange) => {
        setDateRange(range);
    }, []);

    const handleCreateDefault = async () => {
        setCreatingBook(true);
        try {
            const res = await fetch('/api/books/default', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'My Finances' }),
            });
            if (res.ok) {
                const data = await res.json();
                // Switch to new book
                await fetch('/api/books/active', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ bookGuid: data.bookGuid }),
                });
                // Reload to show dashboard with new book
                window.location.reload();
            }
        } catch (err) {
            console.error('Error creating default book:', err);
        } finally {
            setCreatingBook(false);
        }
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
                    {/* Create Default Book Card */}
                    <button
                        onClick={handleCreateDefault}
                        disabled={creatingBook}
                        className="bg-surface border border-border rounded-xl p-6 text-left hover:border-emerald-500/50 transition-colors group disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <div className="flex items-center gap-3 mb-3">
                            <div className="flex items-center justify-center w-10 h-10 bg-emerald-500/10 rounded-lg group-hover:bg-emerald-500/20 transition-colors">
                                <svg className="w-5 h-5 text-emerald-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m6-6H6" />
                                </svg>
                            </div>
                            <h3 className="text-lg font-semibold text-foreground">Create Default Book</h3>
                        </div>
                        <p className="text-sm text-foreground-secondary">
                            Start with a pre-configured account hierarchy including Assets, Liabilities, Income, Expenses, and Equity with common sub-accounts.
                        </p>
                    </button>

                    {/* Import Card */}
                    <Link href="/import-export" className="bg-surface border border-border rounded-xl p-6 text-left hover:border-cyan-500/50 transition-colors group">
                        <div className="flex items-center gap-3 mb-3">
                            <div className="flex items-center justify-center w-10 h-10 bg-cyan-500/10 rounded-lg group-hover:bg-cyan-500/20 transition-colors">
                                <svg className="w-5 h-5 text-cyan-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
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
            </div>
        );
    }

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
                <DateRangePicker
                    startDate={dateRange.startDate}
                    endDate={dateRange.endDate}
                    onChange={handleDateChange}
                />
            </div>

            {/* KPI Cards */}
            <KPIGrid data={kpiData} loading={kpiLoading} />

            {/* Net Worth Chart - full width */}
            <ExpandableChart title="Net Worth Over Time">
                <NetWorthChart data={netWorthData} loading={netWorthLoading} />
            </ExpandableChart>

            {/* Sankey + Expense Pie + Income Pie - 3 columns */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <ExpandableChart title="Income Flow">
                    <SankeyDiagram
                        data={sankeyData}
                        loading={sankeyLoading}
                    />
                </ExpandableChart>
                <ExpandableChart title="Expenses by Category">
                    <ExpensePieChart data={expenseCategories} loading={sankeyLoading} />
                </ExpandableChart>
                <ExpandableChart title="Income by Category">
                    <IncomePieChart data={incomeCategories} loading={sankeyLoading} />
                </ExpandableChart>
            </div>

            {/* Income vs Expense Bar Chart - full width */}
            <ExpandableChart title="Income vs Expenses">
                <IncomeExpenseBarChart data={monthlyData} loading={monthlyLoading} />
            </ExpandableChart>

            {/* Net Profit by Month - full width */}
            <ExpandableChart title="Net Profit by Month">
                <NetProfitChart data={monthlyData} loading={monthlyLoading} />
            </ExpandableChart>

            {/* Tax Pie - half width */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <ExpandableChart title="Taxes by Category">
                    <TaxPieChart data={taxCategories} loading={sankeyLoading} />
                </ExpandableChart>
            </div>
        </div>
    );
}
