'use client';

import { ReactNode } from 'react';
import { ReportFilters as ReportFiltersType } from '@/lib/reports/types';
import { ReportFilters } from './ReportFilters';

interface ReportViewerProps {
    title: string;
    description?: string;
    filters: ReportFiltersType;
    onFilterChange: (filters: ReportFiltersType) => void;
    isLoading?: boolean;
    error?: string | null;
    children: ReactNode;
    showCompare?: boolean;
}

export function ReportViewer({
    title,
    description,
    filters,
    onFilterChange,
    isLoading,
    error,
    children,
    showCompare = true,
}: ReportViewerProps) {
    const handlePrint = () => {
        window.print();
    };

    const handleExport = (format: 'csv' | 'excel') => {
        // TODO: Implement export functionality
        console.log(`Export to ${format}`);
    };

    return (
        <div className="space-y-6">
            {/* Header */}
            <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-foreground">{title}</h1>
                    {description && (
                        <p className="text-foreground-muted mt-1">{description}</p>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => handleExport('csv')}
                        className="flex items-center gap-2 px-3 py-2 text-sm bg-background-tertiary hover:bg-surface-hover text-foreground-secondary rounded-lg transition-colors"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                        CSV
                    </button>
                    <button
                        onClick={handlePrint}
                        className="flex items-center gap-2 px-3 py-2 text-sm bg-background-tertiary hover:bg-surface-hover text-foreground-secondary rounded-lg transition-colors"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                        </svg>
                        Print
                    </button>
                </div>
            </header>

            {/* Filters */}
            <ReportFilters
                filters={filters}
                onChange={onFilterChange}
                showCompare={showCompare}
            />

            {/* Content */}
            {isLoading ? (
                <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-2xl p-12 flex items-center justify-center">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Generating report...</span>
                    </div>
                </div>
            ) : error ? (
                <div className="bg-background-secondary/30 backdrop-blur-xl border border-rose-800/50 rounded-2xl p-12 text-center">
                    <div className="text-rose-400">{error}</div>
                </div>
            ) : (
                <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-2xl overflow-hidden print:bg-white print:border-0">
                    {children}
                </div>
            )}

            {/* Print Styles */}
            <style jsx global>{`
                @media print {
                    body * {
                        visibility: hidden;
                    }
                    .print\\:bg-white,
                    .print\\:bg-white * {
                        visibility: visible;
                    }
                    .print\\:bg-white {
                        position: absolute;
                        left: 0;
                        top: 0;
                        width: 100%;
                    }
                }
            `}</style>
        </div>
    );
}
