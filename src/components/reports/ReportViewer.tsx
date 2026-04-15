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
                <!-- Blank <title> so the browser's print header doesn't -->
                <!-- show the page name above the report content. -->
                <title></title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        color: #000;
                        background: #fff;
                        margin: 12px;
                        line-height: 1.25;
                        font-size: 10px;
                    }
                    h1, h2, h3 { margin: 0.25em 0; line-height: 1.2; }
                    h1 { font-size: 16px; border-bottom: 1px solid #333; padding-bottom: 3px; margin-bottom: 8px; }
                    h2 { font-size: 13px; color: #333; margin-top: 10px; }
                    h3 { font-size: 11px; color: #444; margin-top: 8px; margin-bottom: 4px; padding-bottom: 2px; border-bottom: 1px solid #888; }
                    p { margin: 2px 0; }
                    /* Collapse the oversized Tailwind spacing utilities in the cloned markup */
                    [class*="space-y-8"] > * + *, [class*="space-y-6"] > * + * { margin-top: 10px !important; }
                    [class*="space-y-4"] > * + * { margin-top: 6px !important; }
                    [class*="space-y-2"] > * + *, [class*="space-y-1"] > * + * { margin-top: 2px !important; }
                    [class*="p-6"], [class*="p-4"] { padding: 6px !important; }
                    [class*="py-"] { padding-top: 2px !important; padding-bottom: 2px !important; }
                    [class*="px-"] { padding-left: 4px !important; padding-right: 4px !important; }
                    [class*="mb-3"], [class*="mb-2"] { margin-bottom: 3px !important; }
                    [class*="pb-2"], [class*="pb-1"] { padding-bottom: 2px !important; }
                    table {
                        width: 100%;
                        border-collapse: collapse;
                        margin: 4px 0;
                        font-size: 10px;
                    }
                    th, td {
                        border-bottom: 1px solid #ddd;
                        padding: 2px 6px;
                        text-align: left;
                        line-height: 1.25;
                    }
                    th { background: #eee; font-weight: 600; }
                    tr { page-break-inside: avoid; }
                    section { page-break-inside: avoid; }
                    .text-right, [class*="text-right"] { text-align: right; }
                    .font-bold, [class*="font-bold"] { font-weight: 700; }
                    .font-semibold, [class*="font-semibold"] { font-weight: 600; }
                    .font-mono, [class*="font-mono"] { font-family: 'Courier New', Courier, monospace; font-size: 10px; }
                    td[class*="text-right"], th[class*="text-right"] { text-align: right; }
                    tfoot td, tfoot th { font-weight: 700; border-top: 1px solid #333; }
                    .text-center, [class*="text-center"] { text-align: center; }
                    button, [role="button"], .no-print { display: none !important; }
                    * {
                        color: #000 !important;
                        background-color: transparent !important;
                        border-color: #ccc !important;
                    }
                    @media print {
                        /* margin:0 on @page + body padding pushes the browser's
                           auto-generated header/footer (URL + date + page #)
                           off the printable area on most browsers. */
                        @page { margin: 0; size: auto; }
                        body { margin: 0; padding: 1cm; }
                        h2, h3 { page-break-after: avoid; }
                    }
                </style>
            </head>
            <body>
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
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
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
