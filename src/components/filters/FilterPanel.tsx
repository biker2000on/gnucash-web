'use client';

import { ReactNode, useState } from 'react';

interface FilterPanelProps {
    children: ReactNode;
    activeFilterCount: number;
    onClearAll: () => void;
}

export function FilterPanel({ children, activeFilterCount, onClearAll }: FilterPanelProps) {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <div className="relative">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className={`flex items-center gap-2 px-4 py-2 text-sm rounded-xl border transition-all ${
                    activeFilterCount > 0
                        ? 'bg-cyan-500/10 border-cyan-500/50 text-cyan-400'
                        : 'bg-surface/50 border-border text-foreground-secondary hover:border-cyan-500/50'
                }`}
            >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                </svg>
                <span>Filters</span>
                {activeFilterCount > 0 && (
                    <span className="bg-cyan-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
                        {activeFilterCount}
                    </span>
                )}
                <svg className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </button>

            {isOpen && (
                <div className="absolute top-full left-0 mt-2 w-80 bg-background-secondary border border-border rounded-xl shadow-xl z-50 overflow-hidden">
                    <div className="p-4 space-y-4">
                        {children}
                    </div>
                    {activeFilterCount > 0 && (
                        <div className="px-4 py-3 bg-input-bg border-t border-border">
                            <button
                                onClick={() => {
                                    onClearAll();
                                    setIsOpen(false);
                                }}
                                className="w-full text-sm text-foreground-secondary hover:text-rose-400 transition-colors"
                            >
                                Clear all filters
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
