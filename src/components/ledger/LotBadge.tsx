'use client';

import { useState } from 'react';
import { formatCurrency } from '@/lib/format';

interface LotTooltipData {
    title: string;
    shares: number;
    costBasis: number;
    unrealizedGain: number | null;
    holdingPeriod: 'short_term' | 'long_term' | null;
    currencyMnemonic: string;
}

interface LotBadgeProps {
    lotGuid: string;
    lotIndex: number;        // 1-based index for display
    isClosed: boolean;
    tooltip?: LotTooltipData;
    className?: string;
    sharePrecision?: number;
}

// Consistent color palette for lot badges (up to 12 distinct colors, then cycle)
const LOT_COLORS = [
    'bg-blue-500/20 text-blue-400 border-blue-500/30',
    'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    'bg-amber-500/20 text-amber-400 border-amber-500/30',
    'bg-purple-500/20 text-purple-400 border-purple-500/30',
    'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
    'bg-rose-500/20 text-rose-400 border-rose-500/30',
    'bg-orange-500/20 text-orange-400 border-orange-500/30',
    'bg-teal-500/20 text-teal-400 border-teal-500/30',
    'bg-indigo-500/20 text-indigo-400 border-indigo-500/30',
    'bg-pink-500/20 text-pink-400 border-pink-500/30',
    'bg-lime-500/20 text-lime-400 border-lime-500/30',
    'bg-sky-500/20 text-sky-400 border-sky-500/30',
];

export default function LotBadge({ lotIndex, isClosed, tooltip, className = '', sharePrecision: sp = 4 }: LotBadgeProps) {
    const [showTooltip, setShowTooltip] = useState(false);
    const colorIndex = (lotIndex - 1) % LOT_COLORS.length;
    const colorClass = isClosed
        ? 'bg-foreground-muted/10 text-foreground-muted border-foreground-muted/20 line-through'
        : LOT_COLORS[colorIndex];

    return (
        <span
            className={`relative inline-flex items-center ${className}`}
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
        >
            <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${colorClass} cursor-default`}
            >
                L{lotIndex}
            </span>

            {showTooltip && tooltip && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 pointer-events-none">
                    <div className="bg-surface border border-border rounded-lg shadow-xl px-3 py-2 text-xs whitespace-nowrap">
                        <div className="font-semibold text-foreground mb-1">{tooltip.title}</div>
                        <div className="space-y-0.5 text-foreground-secondary">
                            <div>Shares: <span className="font-mono">{tooltip.shares.toFixed(sp)}</span></div>
                            <div>Cost: <span className="font-mono">{formatCurrency(tooltip.costBasis, tooltip.currencyMnemonic)}</span></div>
                            {tooltip.unrealizedGain !== null && (
                                <div>
                                    Unrealized:{' '}
                                    <span className={`font-mono ${tooltip.unrealizedGain >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                        {tooltip.unrealizedGain >= 0 ? '+' : ''}{formatCurrency(tooltip.unrealizedGain, tooltip.currencyMnemonic)}
                                    </span>
                                </div>
                            )}
                            {tooltip.holdingPeriod && (
                                <div>
                                    <span className={`inline-flex items-center px-1 py-0.5 rounded text-[9px] font-bold ${
                                        tooltip.holdingPeriod === 'long_term'
                                            ? 'bg-primary/20 text-primary'
                                            : 'bg-amber-500/20 text-amber-400'
                                    }`}>
                                        {tooltip.holdingPeriod === 'long_term' ? 'LT' : 'ST'}
                                    </span>
                                </div>
                            )}
                        </div>
                        {/* Tooltip arrow */}
                        <div className="absolute top-full left-1/2 -translate-x-1/2 w-2 h-2 bg-surface border-r border-b border-border rotate-45 -mt-1" />
                    </div>
                </div>
            )}
        </span>
    );
}
