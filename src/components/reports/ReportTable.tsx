'use client';

import { LineItem, ReportSection } from '@/lib/reports/types';
import { formatCurrency } from '@/lib/format';
import { useState } from 'react';

interface ReportTableProps {
    sections: ReportSection[];
    showComparison?: boolean;
    currencyCode?: string;
}

interface LineItemRowProps {
    item: LineItem;
    showComparison?: boolean;
    currencyCode: string;
    expanded: Set<string>;
    toggleExpanded: (guid: string) => void;
}

function LineItemRow({ item, showComparison, currencyCode, expanded, toggleExpanded }: LineItemRowProps) {
    const hasChildren = item.children && item.children.length > 0;
    const isExpanded = expanded.has(item.guid);
    const indent = (item.depth || 0) * 24;

    const change = item.previousAmount !== undefined
        ? item.amount - item.previousAmount
        : undefined;

    const changePercent = item.previousAmount !== undefined && item.previousAmount !== 0
        ? ((item.amount - item.previousAmount) / Math.abs(item.previousAmount)) * 100
        : undefined;

    return (
        <>
            <tr className={`${item.isTotal ? 'bg-neutral-800/50 font-semibold' : item.isSubtotal ? 'bg-neutral-800/30' : 'hover:bg-neutral-800/20'} transition-colors`}>
                <td className="py-2 px-4">
                    <div className="flex items-center" style={{ paddingLeft: `${indent}px` }}>
                        {hasChildren && (
                            <button
                                onClick={() => toggleExpanded(item.guid)}
                                className="w-5 h-5 mr-2 flex items-center justify-center text-neutral-500 hover:text-neutral-300"
                            >
                                <svg
                                    className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                            </button>
                        )}
                        {!hasChildren && <span className="w-7" />}
                        <span className={item.isTotal || item.isSubtotal ? 'text-neutral-100' : 'text-neutral-300'}>
                            {item.name}
                        </span>
                    </div>
                </td>
                <td className="py-2 px-4 text-right font-mono">
                    <span className={item.amount >= 0 ? 'text-neutral-200' : 'text-rose-400'}>
                        {formatCurrency(item.amount, currencyCode)}
                    </span>
                </td>
                {showComparison && (
                    <>
                        <td className="py-2 px-4 text-right font-mono text-neutral-400">
                            {item.previousAmount !== undefined
                                ? formatCurrency(item.previousAmount, currencyCode)
                                : '-'
                            }
                        </td>
                        <td className="py-2 px-4 text-right font-mono">
                            {change !== undefined ? (
                                <span className={change >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                    {change >= 0 ? '+' : ''}{formatCurrency(change, currencyCode)}
                                    {changePercent !== undefined && (
                                        <span className="text-xs ml-1">
                                            ({changePercent >= 0 ? '+' : ''}{changePercent.toFixed(1)}%)
                                        </span>
                                    )}
                                </span>
                            ) : '-'}
                        </td>
                    </>
                )}
            </tr>
            {hasChildren && isExpanded && item.children!.map(child => (
                <LineItemRow
                    key={child.guid}
                    item={child}
                    showComparison={showComparison}
                    currencyCode={currencyCode}
                    expanded={expanded}
                    toggleExpanded={toggleExpanded}
                />
            ))}
        </>
    );
}

export function ReportTable({ sections, showComparison, currencyCode = 'USD' }: ReportTableProps) {
    const [expanded, setExpanded] = useState<Set<string>>(() => {
        // Start with all top-level items expanded
        const initial = new Set<string>();
        sections.forEach(section => {
            section.items.forEach(item => initial.add(item.guid));
        });
        return initial;
    });

    const toggleExpanded = (guid: string) => {
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(guid)) {
                next.delete(guid);
            } else {
                next.add(guid);
            }
            return next;
        });
    };

    // Calculate max depth across all sections
    const getMaxDepth = (items: LineItem[], currentDepth = 0): number => {
        let max = currentDepth;
        items.forEach(item => {
            if (item.children) {
                max = Math.max(max, getMaxDepth(item.children, currentDepth + 1));
            }
        });
        return max;
    };
    const maxDepth = sections.reduce((max, section) => Math.max(max, getMaxDepth(section.items)), 0);

    const expandAll = () => {
        const all = new Set<string>();
        const addAllItems = (items: LineItem[]) => {
            items.forEach(item => {
                all.add(item.guid);
                if (item.children) addAllItems(item.children);
            });
        };
        sections.forEach(section => addAllItems(section.items));
        setExpanded(all);
    };

    const collapseAll = () => {
        setExpanded(new Set());
    };

    const expandToLevel = (level: number) => {
        const result = new Set<string>();
        const addItemsToLevel = (items: LineItem[], currentDepth: number) => {
            items.forEach(item => {
                if (currentDepth < level && item.children) {
                    result.add(item.guid);
                    addItemsToLevel(item.children, currentDepth + 1);
                }
            });
        };
        sections.forEach(section => addItemsToLevel(section.items, 0));
        setExpanded(result);
    };

    return (
        <div>
            <div className="flex justify-end items-center gap-2 p-2 border-b border-neutral-800">
                {maxDepth > 0 && (
                    <div className="flex items-center gap-1 mr-2">
                        <label className="text-xs text-neutral-500">Level:</label>
                        <select
                            onChange={(e) => {
                                const val = e.target.value;
                                if (val === 'all') expandAll();
                                else expandToLevel(Number(val));
                            }}
                            defaultValue="1"
                            className="bg-neutral-800 border border-neutral-700 text-neutral-300 text-xs rounded px-1.5 py-0.5 focus:outline-none focus:border-neutral-500"
                        >
                            {Array.from({ length: maxDepth + 1 }, (_, i) => (
                                <option key={i} value={i}>
                                    {i === 0 ? 'None' : i}
                                </option>
                            ))}
                            <option value="all">All</option>
                        </select>
                    </div>
                )}
                <button
                    onClick={expandAll}
                    className="px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
                >
                    Expand All
                </button>
                <button
                    onClick={collapseAll}
                    className="px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
                >
                    Collapse All
                </button>
            </div>
            {sections.map(section => (
                <div key={section.title} className="mb-6">
                    <div className="bg-gradient-to-r from-neutral-800/50 to-transparent py-3 px-4 border-b border-neutral-700">
                        <h3 className="text-lg font-semibold text-neutral-100">{section.title}</h3>
                    </div>
                    <table className="w-full">
                        <thead>
                            <tr className="border-b border-neutral-700 text-neutral-400 text-sm uppercase tracking-wider">
                                <th className="py-2 px-4 text-left font-medium">Account</th>
                                <th className="py-2 px-4 text-right font-medium">Balance</th>
                                {showComparison && (
                                    <>
                                        <th className="py-2 px-4 text-right font-medium">Previous</th>
                                        <th className="py-2 px-4 text-right font-medium">Change</th>
                                    </>
                                )}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-neutral-800/50">
                            {section.items.map(item => (
                                <LineItemRow
                                    key={item.guid}
                                    item={item}
                                    showComparison={showComparison}
                                    currencyCode={currencyCode}
                                    expanded={expanded}
                                    toggleExpanded={toggleExpanded}
                                />
                            ))}
                        </tbody>
                        <tfoot>
                            <tr className="border-t-2 border-neutral-600 bg-neutral-800/50">
                                <td className="py-3 px-4 font-semibold text-neutral-100">
                                    Total {section.title}
                                </td>
                                <td className="py-3 px-4 text-right font-mono font-semibold text-neutral-100">
                                    {formatCurrency(section.total, currencyCode)}
                                </td>
                                {showComparison && (
                                    <>
                                        <td className="py-3 px-4 text-right font-mono text-neutral-400">
                                            {section.previousTotal !== undefined
                                                ? formatCurrency(section.previousTotal, currencyCode)
                                                : '-'
                                            }
                                        </td>
                                        <td className="py-3 px-4 text-right font-mono">
                                            {section.previousTotal !== undefined ? (
                                                <span className={section.total - section.previousTotal >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                                    {section.total - section.previousTotal >= 0 ? '+' : ''}
                                                    {formatCurrency(section.total - section.previousTotal, currencyCode)}
                                                </span>
                                            ) : '-'}
                                        </td>
                                    </>
                                )}
                            </tr>
                        </tfoot>
                    </table>
                </div>
            ))}
        </div>
    );
}
