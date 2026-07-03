'use client';

import { useState, ReactNode } from 'react';

interface FilterBarProps {
    /**
     * Controls that stay visible on all screen sizes (e.g. a search input or
     * date range picker). Keep to one or two.
     */
    primary?: ReactNode;
    /** Number of currently-active filters, shown as a badge on the toggle. */
    activeCount?: number;
    /** The rest of the filter controls; inline on desktop, collapsed on mobile. */
    children?: ReactNode;
    className?: string;
}

/**
 * Responsive filter toolbar. On md+ screens everything renders inline like a
 * normal toolbar. On small screens only `primary` stays visible next to a
 * "Filters" disclosure button; the remaining controls expand underneath.
 */
export function FilterBar({ primary, activeCount = 0, children, className = '' }: FilterBarProps) {
    const [open, setOpen] = useState(false);
    const hasCollapsible = children !== undefined && children !== null;

    return (
        <div className={className}>
            {/* Desktop: single inline row */}
            <div className="hidden md:flex md:items-center md:gap-2 md:flex-wrap">
                {primary}
                {children}
            </div>

            {/* Mobile: primary + disclosure toggle */}
            <div className="md:hidden">
                <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0 flex items-center gap-2">{primary}</div>
                    {hasCollapsible && (
                        <button
                            onClick={() => setOpen(o => !o)}
                            aria-expanded={open}
                            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm shrink-0 transition-colors ${
                                open || activeCount > 0
                                    ? 'border-primary/50 bg-primary/10 text-primary'
                                    : 'border-border bg-surface/50 text-foreground-secondary'
                            }`}
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 01-.659 1.591l-5.432 5.432a2.25 2.25 0 00-.659 1.591v2.927a2.25 2.25 0 01-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 00-.659-1.591L3.659 7.409A2.25 2.25 0 013 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0112 3z" />
                            </svg>
                            Filters
                            {activeCount > 0 && (
                                <span className="min-w-5 h-5 px-1 rounded-full bg-primary text-primary-foreground text-xs font-medium flex items-center justify-center">
                                    {activeCount}
                                </span>
                            )}
                        </button>
                    )}
                </div>
                {hasCollapsible && open && (
                    <div className="mt-2 p-3 bg-surface border border-border rounded-lg flex flex-col gap-2 [&>*]:w-full">
                        {children}
                    </div>
                )}
            </div>
        </div>
    );
}
