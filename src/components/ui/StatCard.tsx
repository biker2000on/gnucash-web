'use client';

import { ReactNode } from 'react';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

export type StatTone = 'default' | 'positive' | 'negative' | 'warning' | 'primary';
export type StatSize = 'default' | 'compact';

/** Map a semantic tone to the DESIGN.md color token class for the value. */
export function statToneClass(tone: StatTone = 'default'): string {
    switch (tone) {
        case 'positive':
            return 'text-positive';
        case 'negative':
            return 'text-negative';
        case 'warning':
            return 'text-warning';
        case 'primary':
            return 'text-primary';
        default:
            return 'text-foreground';
    }
}

/** Responsive column classes for a stat grid (always 2-up on phones). */
export function statGridColsClass(cols: 2 | 3 | 4 | 5 = 4): string {
    switch (cols) {
        case 2:
            return 'grid grid-cols-2 gap-2 sm:gap-4';
        case 3:
            return 'grid grid-cols-2 gap-2 sm:gap-4 sm:grid-cols-3';
        case 5:
            return 'grid grid-cols-2 gap-2 sm:gap-4 sm:grid-cols-3 lg:grid-cols-5';
        case 4:
        default:
            return 'grid grid-cols-2 gap-2 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4';
    }
}

export interface StatCardProps {
    label: ReactNode;
    value: ReactNode;
    sub?: ReactNode;
    tone?: StatTone;
    /**
     * default: dense tile on phones (<sm), comfortable card on sm+.
     * compact: dense tile at every breakpoint (header/summary strips).
     */
    size?: StatSize;
    className?: string;
}

/**
 * Shared KPI/stat tile. Compact by default on mobile — small uppercase label,
 * JetBrains Mono tabular-nums value — expanding to the comfortable desktop
 * card at the sm breakpoint. Use inside <StatGrid>.
 */
export function StatCard({
    label,
    value,
    sub,
    tone = 'default',
    size = 'default',
    className = '',
}: StatCardProps) {
    const compact = size === 'compact';
    return (
        <div
            className={`bg-surface/30 border border-border min-w-0 ${
                compact ? 'rounded-lg px-3 py-2' : 'rounded-lg px-3 py-2 sm:rounded-xl sm:p-5'
            } ${className}`}
        >
            <div
                className={`uppercase tracking-wider text-foreground-muted leading-tight ${
                    compact ? 'text-[10px]' : 'text-[10px] sm:text-xs'
                }`}
            >
                {label}
            </div>
            <div
                className={`font-mono font-semibold tabular-nums ${statToneClass(tone)} ${
                    compact ? 'mt-0.5 text-sm sm:text-base' : 'mt-0.5 text-base sm:mt-1 sm:text-2xl'
                }`}
                style={TNUM}
            >
                {value}
            </div>
            {sub != null && sub !== '' && (
                <div
                    className={`text-foreground-muted truncate ${
                        compact ? 'mt-0.5 text-[10px]' : 'mt-0.5 text-[11px] sm:mt-1 sm:text-xs'
                    }`}
                >
                    {sub}
                </div>
            )}
        </div>
    );
}

export interface StatGridProps {
    /** Column count at lg+; phones always get a 2-up grid. */
    cols?: 2 | 3 | 4 | 5;
    className?: string;
    children: ReactNode;
}

/** Responsive wrapper for StatCards: 2 columns on phones, cols at larger sizes. */
export function StatGrid({ cols = 4, className = '', children }: StatGridProps) {
    return <div className={`${statGridColsClass(cols)} ${className}`}>{children}</div>;
}
