'use client';

import { useContext, useState, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { ExpandedContext } from '@/components/charts/ExpandableChart';

const SankeyChart = dynamic(() => import('@/components/charts/SankeyChart'), { ssr: false });

export interface SankeyHierarchyNode {
    guid: string;
    name: string;
    value: number;
    depth: number;
    children: SankeyHierarchyNode[];
}

export interface SankeyResponseData {
    income: SankeyHierarchyNode[];
    expense: SankeyHierarchyNode[];
    totalIncome: number;
    totalExpenses: number;
    savings: number;
    maxDepth: number;
}

interface SankeyDiagramProps {
    data: SankeyResponseData | null;
    loading: boolean;
}

// ---------------------------------------------------------------------------
// Flatten hierarchical tree to flat Sankey nodes/links for D3
// ---------------------------------------------------------------------------

function flattenToSankey(
    incomeTree: SankeyHierarchyNode[],
    expenseTree: SankeyHierarchyNode[],
    totalIncome: number,
    totalExpenses: number,
    savings: number,
    displayLevels: number
): { nodes: { name: string }[]; links: { source: number; target: number; value: number }[] } {
    const nodes: { name: string }[] = [];
    const links: { source: number; target: number; value: number }[] = [];

    // --- Collect income-side level nodes ---
    const incomeLevelNodes: Map<number, { name: string; value: number; parentName: string | null }[]> = new Map();

    function collectIncomeNodes(
        tree: SankeyHierarchyNode[],
        parentName: string | null,
        currentDepth: number,
        maxDisplayDepth: number
    ) {
        for (const node of tree) {
            if (currentDepth < maxDisplayDepth) {
                const level = incomeLevelNodes.get(currentDepth) || [];
                level.push({ name: node.name, value: node.value, parentName });
                incomeLevelNodes.set(currentDepth, level);

                if (currentDepth + 1 < maxDisplayDepth && node.children.length > 0) {
                    collectIncomeNodes(node.children, node.name, currentDepth + 1, maxDisplayDepth);
                }
            }
        }
    }

    collectIncomeNodes(incomeTree, null, 0, displayLevels);

    // Duplicate name handling
    const usedNames = new Set<string>();
    function uniqueName(name: string, side: 'income' | 'expense'): string {
        const candidate = name;
        if (!usedNames.has(candidate)) {
            usedNames.add(candidate);
            return candidate;
        }
        const disambiguated = `${name} (${side === 'income' ? 'Inc' : 'Exp'})`;
        usedNames.add(disambiguated);
        return disambiguated;
    }

    // Income levels: add from deepest to shallowest (left-most columns first in the chart)
    const incomeNodeIndices: Map<string, number> = new Map();
    for (let level = displayLevels - 1; level >= 0; level--) {
        const levelNodes = incomeLevelNodes.get(level) || [];
        for (const ln of levelNodes) {
            const name = uniqueName(ln.name, 'income');
            const idx = nodes.length;
            nodes.push({ name });
            incomeNodeIndices.set(`${level}:${ln.name}`, idx);
        }
    }

    // Central nodes
    const totalIncomeIdx = nodes.length;
    nodes.push({ name: 'Total Income' });
    const totalExpSavingsIdx = nodes.length;
    nodes.push({ name: 'Total Expenses + Savings' });

    // --- Collect expense-side level nodes ---
    const expenseLevelNodes: Map<number, { name: string; value: number; parentName: string | null }[]> = new Map();

    function collectExpenseNodes(
        tree: SankeyHierarchyNode[],
        parentName: string | null,
        currentDepth: number,
        maxDisplayDepth: number
    ) {
        for (const node of tree) {
            if (currentDepth < maxDisplayDepth) {
                const level = expenseLevelNodes.get(currentDepth) || [];
                level.push({ name: node.name, value: node.value, parentName });
                expenseLevelNodes.set(currentDepth, level);

                if (currentDepth + 1 < maxDisplayDepth && node.children.length > 0) {
                    collectExpenseNodes(node.children, node.name, currentDepth + 1, maxDisplayDepth);
                }
            }
        }
    }

    collectExpenseNodes(expenseTree, null, 0, displayLevels);

    // Expense levels: add from shallowest to deepest (left to right after center)
    const expenseNodeIndices: Map<string, number> = new Map();
    for (let level = 0; level < displayLevels; level++) {
        const levelNodes = expenseLevelNodes.get(level) || [];
        for (const ln of levelNodes) {
            const name = uniqueName(ln.name, 'expense');
            const idx = nodes.length;
            nodes.push({ name });
            expenseNodeIndices.set(`${level}:${ln.name}`, idx);
        }
    }

    // Add Savings node if positive
    let savingsIdx = -1;
    if (savings > 0) {
        savingsIdx = nodes.length;
        nodes.push({ name: 'Savings' });
    }

    // --- Build links ---

    // Income side: deeper levels link to their parent level
    for (let level = displayLevels - 1; level > 0; level--) {
        const levelNodes = incomeLevelNodes.get(level) || [];
        for (const ln of levelNodes) {
            const sourceIdx = incomeNodeIndices.get(`${level}:${ln.name}`);
            const targetIdx = incomeNodeIndices.get(`${level - 1}:${ln.parentName}`);
            if (sourceIdx !== undefined && targetIdx !== undefined && ln.value > 0) {
                links.push({ source: sourceIdx, target: targetIdx, value: ln.value });
            }
        }
    }

    // Shallowest income level (level 0) links to Total Income
    const level0Income = incomeLevelNodes.get(0) || [];
    for (const ln of level0Income) {
        const sourceIdx = incomeNodeIndices.get(`0:${ln.name}`);
        if (sourceIdx !== undefined && ln.value > 0) {
            links.push({ source: sourceIdx, target: totalIncomeIdx, value: ln.value });
        }
    }

    // Total Income links to Total Expenses + Savings
    if (totalIncome > 0) {
        links.push({ source: totalIncomeIdx, target: totalExpSavingsIdx, value: totalIncome });
    }

    // Total Expenses + Savings links to shallowest expense level (level 0) and savings
    const level0Expense = expenseLevelNodes.get(0) || [];
    for (const ln of level0Expense) {
        const targetIdx = expenseNodeIndices.get(`0:${ln.name}`);
        if (targetIdx !== undefined && ln.value > 0) {
            links.push({ source: totalExpSavingsIdx, target: targetIdx, value: ln.value });
        }
    }
    if (savings > 0 && savingsIdx >= 0) {
        links.push({ source: totalExpSavingsIdx, target: savingsIdx, value: savings });
    }

    // Expense side: shallower levels link to deeper levels
    for (let level = 0; level < displayLevels - 1; level++) {
        const nextLevelNodes = expenseLevelNodes.get(level + 1) || [];
        for (const ln of nextLevelNodes) {
            const sourceIdx = expenseNodeIndices.get(`${level}:${ln.parentName}`);
            const targetIdx = expenseNodeIndices.get(`${level + 1}:${ln.name}`);
            if (sourceIdx !== undefined && targetIdx !== undefined && ln.value > 0) {
                links.push({ source: sourceIdx, target: targetIdx, value: ln.value });
            }
        }
    }

    return { nodes, links };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function ChartSkeleton() {
    return (
        <div className="bg-surface border border-border rounded-xl p-6 animate-pulse">
            <div className="h-5 w-48 bg-background-secondary rounded mb-6" />
            <div className="h-[500px] bg-background-secondary rounded" />
        </div>
    );
}

export default function SankeyDiagram({ data, loading }: SankeyDiagramProps) {
    const expanded = useContext(ExpandedContext);
    const [displayLevel, setDisplayLevel] = useState(1);

    const maxDepth = data?.maxDepth ?? 0;

    const { nodes, links } = useMemo(() => {
        if (!data || data.maxDepth === 0) {
            return { nodes: [], links: [] };
        }
        return flattenToSankey(
            data.income,
            data.expense,
            data.totalIncome,
            data.totalExpenses,
            data.savings,
            displayLevel
        );
    }, [data, displayLevel]);

    if (loading) return <ChartSkeleton />;

    if (!data || (nodes.length === 0 && links.length === 0)) {
        return (
            <div className={`bg-surface border border-border rounded-xl p-6 ${expanded ? 'h-full' : ''}`}>
                <h3 className="text-lg font-semibold text-foreground mb-4">Income Flow</h3>
                <div className="h-[500px] flex items-center justify-center">
                    <p className="text-foreground-muted text-sm">No flow data available for this period.</p>
                </div>
            </div>
        );
    }

    return (
        <div className={`bg-surface border border-border rounded-xl p-6 ${expanded ? 'h-full' : ''}`}>
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-foreground">Income Flow</h3>
                {maxDepth > 1 && (
                    <select
                        value={displayLevel}
                        onChange={(e) => setDisplayLevel(parseInt(e.target.value))}
                        className="text-sm bg-background border border-border rounded px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    >
                        {Array.from({ length: maxDepth }, (_, i) => (
                            <option key={i + 1} value={i + 1}>
                                Level {i + 1}
                            </option>
                        ))}
                    </select>
                )}
            </div>
            <SankeyChart nodes={nodes} links={links} height={expanded ? undefined : 500} />
        </div>
    );
}
