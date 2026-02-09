'use client';

import { ReactNode, useRef } from 'react';
import { ReportFilters as ReportFiltersType, ReportData } from '@/lib/reports/types';
import { ReportFilters } from './ReportFilters';
import { generateCSV, downloadCSV } from '@/lib/reports/csv-export';

function escapeHtml(s: string): string {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

interface ReportViewerProps {
    title: string;
    description?: string;
    filters: ReportFiltersType;
    onFilterChange: (filters: ReportFiltersType) => void;
    isLoading?: boolean;
    error?: string | null;
    children: ReactNode;
    showCompare?: boolean;
    reportData?: ReportData;
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
    reportData,
}: ReportViewerProps) {
    const reportContentRef = useRef<HTMLDivElement>(null);

    const handlePrint = () => {
        if (!reportContentRef.current) return;
        const printWindow = window.open('', '_blank', 'width=800,height=600');
        if (!printWindow) return;
        const content = reportContentRef.current.innerHTML;
        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>${escapeHtml(title)}</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        color: #000;
                        background: #fff;
                        margin: 20px;
                        line-height: 1.5;
                    }
                    h1, h2, h3 { margin: 0.5em 0; }
                    h1 { font-size: 24px; border-bottom: 2px solid #333; padding-bottom: 8px; }
                    h2 { font-size: 18px; color: #444; }
                    h3 { font-size: 14px; color: #666; }
                    table {
                        width: 100%;
                        border-collapse: collapse;
                        margin: 12px 0;
                        font-size: 12px;
                    }
                    th, td {
                        border: 1px solid #ddd;
                        padding: 6px 10px;
                        text-align: left;
                    }
                    th {
                        background: #f5f5f5;
                        font-weight: 600;
                    }
                    tr:nth-child(even) { background: #fafafa; }
                    .text-right, [class*="text-right"] { text-align: right; }
                    .font-bold, [class*="font-bold"] { font-weight: 700; }
                    .font-semibold, [class*="font-semibold"] { font-weight: 600; }
                    .font-mono, [class*="font-mono"] { font-family: 'Courier New', Courier, monospace; }
                    td[class*="text-right"], th[class*="text-right"] { text-align: right; }
                    tfoot td, tfoot th { font-weight: 600; border-top: 2px solid #333; }
                    .text-center, [class*="text-center"] { text-align: center; }
                    button, [role="button"], .no-print { display: none !important; }
                    * {
                        color: #000 !important;
                        background-color: transparent !important;
                        border-color: #ddd !important;
                    }
                    @media print {
                        body { margin: 0; }
                        @page { margin: 1.5cm; }
                    }
                </style>
            </head>
            <body>
                <h1>${escapeHtml(title)}</h1>
                ${content}
            </body>
            </html>
        `);
        printWindow.document.close();
        printWindow.focus();
        printWindow.print();
        printWindow.close();
    };

    const handleExport = (format: 'csv' | 'excel') => {
        if (format === 'csv' && reportData) {
            const csv = generateCSV(reportData);
            downloadCSV(csv, `${title.replace(/\s+/g, '_')}_report.csv`);
        }
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
                <div ref={reportContentRef} className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-2xl overflow-hidden">
                    {children}
                </div>
            )}
        </div>
    );
}
