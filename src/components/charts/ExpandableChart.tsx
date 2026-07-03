'use client';

import { useState, createContext, ReactNode } from 'react';
import { Modal } from '@/components/ui/Modal';
import { DateRangePicker } from '@/components/ui/DateRangePicker';

export const ExpandedContext = createContext(false);

export type ChartGroupBy = 'month' | 'quarter' | 'year';

/**
 * View state for an expanded chart. Null when the chart is collapsed (or the
 * chart has no controls), in which case charts render the dashboard-level data.
 */
export interface ChartViewState {
    startDate: string | null;
    endDate: string | null;
    groupBy: ChartGroupBy;
}

export const ChartViewContext = createContext<ChartViewState | null>(null);

const GROUP_OPTIONS: { key: ChartGroupBy; label: string }[] = [
    { key: 'month', label: 'Month' },
    { key: 'quarter', label: 'Quarter' },
    { key: 'year', label: 'Year' },
];

interface ExpandableChartProps {
    title: string;
    children: ReactNode;
    /**
     * Controls shown in the expanded modal:
     * - 'period': time period picker
     * - 'period-group': time period picker + month/quarter/year grouping
     * - undefined: no controls (legacy behavior)
     */
    controls?: 'period' | 'period-group';
    /** Initial period for the expanded view (usually the dashboard period). */
    initialStartDate?: string | null;
    initialEndDate?: string | null;
}

export default function ExpandableChart({
    title,
    children,
    controls,
    initialStartDate = null,
    initialEndDate = null,
}: ExpandableChartProps) {
    const [expanded, setExpanded] = useState(false);
    const [view, setView] = useState<ChartViewState>({
        startDate: initialStartDate,
        endDate: initialEndDate,
        groupBy: 'month',
    });

    const openExpanded = () => {
        // Reset controls to the dashboard's current period each time we expand
        setView({ startDate: initialStartDate, endDate: initialEndDate, groupBy: 'month' });
        setExpanded(true);
    };

    return (
        <div className="relative group h-full">
            {/* Normal view - not rendered when expanded */}
            {!expanded && (
                <div className="h-full">
                    <ExpandedContext.Provider value={false}>
                        {children}
                    </ExpandedContext.Provider>
                </div>
            )}

            {/* Expand button - visible on hover */}
            <button
                onClick={openExpanded}
                className="absolute top-2 right-2 p-1.5 rounded-lg bg-surface/80 backdrop-blur-sm border border-border opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-hover z-10"
                title="Expand chart"
            >
                {/* Expand SVG icon */}
                <svg className="w-4 h-4 text-foreground-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                </svg>
            </button>

            {/* Fullscreen modal */}
            {expanded && (
                <Modal isOpen={expanded} onClose={() => setExpanded(false)} title={title} size="fullscreen">
                    <ExpandedContext.Provider value={true}>
                        <ChartViewContext.Provider value={controls ? view : null}>
                            <div className="w-full h-full min-h-[70vh] p-4 flex flex-col">
                                {controls && (
                                    <div className="flex flex-wrap items-center gap-3 pb-4">
                                        <DateRangePicker
                                            align="left"
                                            startDate={view.startDate}
                                            endDate={view.endDate}
                                            onChange={(range) =>
                                                setView(v => ({ ...v, startDate: range.startDate, endDate: range.endDate }))
                                            }
                                        />
                                        {controls === 'period-group' && (
                                            <div className="flex items-center rounded-xl border border-border bg-surface/50 p-0.5">
                                                {GROUP_OPTIONS.map(opt => (
                                                    <button
                                                        key={opt.key}
                                                        onClick={() => setView(v => ({ ...v, groupBy: opt.key }))}
                                                        className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                                                            view.groupBy === opt.key
                                                                ? 'bg-primary/20 text-primary font-medium'
                                                                : 'text-foreground-secondary hover:bg-surface-hover'
                                                        }`}
                                                    >
                                                        {opt.label}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                                <div className="flex-1 min-h-0">
                                    {children}
                                </div>
                            </div>
                        </ChartViewContext.Provider>
                    </ExpandedContext.Provider>
                </Modal>
            )}
        </div>
    );
}
