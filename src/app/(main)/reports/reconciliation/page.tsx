'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportFilters, ReportData, SavedReport, SavedReportInput, ReportType } from '@/lib/reports/types';
import { ReportTable } from '@/components/reports/ReportTable';
import { AccountPicker } from '@/components/reports/AccountPicker';
import SaveReportDialog from '@/components/reports/SaveReportDialog';

function getDefaultFilters(): ReportFilters {
    const now = new Date();
    return {
        startDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`,
        endDate: now.toISOString().split('T')[0],
        compareToPrevious: false,
    };
}

function ReconciliationReportContent() {
    const searchParams = useSearchParams();
    const savedIdParam = searchParams.get('savedId');

    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [reportData, setReportData] = useState<ReportData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Account selection state
    const [selectedAccountGuids, setSelectedAccountGuids] = useState<string[]>([]);
    const [savedReportId, setSavedReportId] = useState<number | null>(savedIdParam ? parseInt(savedIdParam, 10) : null);
    const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
    const [currentSavedReport, setCurrentSavedReport] = useState<SavedReport | null>(null);

    // Load saved report configuration
    useEffect(() => {
        if (!savedIdParam) return;
        const id = parseInt(savedIdParam, 10);
        if (isNaN(id)) return;

        fetch(`/api/reports/saved/${id}`)
            .then(res => {
                if (!res.ok) throw new Error('Failed to load saved report');
                return res.json();
            })
            .then((saved: SavedReport) => {
                const cfg = saved.config as Record<string, unknown>;
                if (Array.isArray(cfg.accountGuids)) {
                    setSelectedAccountGuids(cfg.accountGuids as string[]);
                }
                if (saved.filters) {
                    setFilters(saved.filters);
                }
                setCurrentSavedReport(saved);
                setSavedReportId(saved.id);
            })
            .catch(() => {
                // silently fall back to defaults
            });
    }, [savedIdParam]);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            const params = new URLSearchParams();
            if (filters.startDate) params.set('startDate', filters.startDate);
            if (filters.endDate) params.set('endDate', filters.endDate);
            if (selectedAccountGuids.length > 0) {
                params.set('accountGuids', selectedAccountGuids.join(','));
            }

            const res = await fetch(`/api/reports/reconciliation?${params}`);
            if (!res.ok) {
                throw new Error('Failed to fetch report');
            }
            const data: ReportData = await res.json();
            setReportData(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setIsLoading(false);
        }
    }, [filters, selectedAccountGuids]);

    useEffect(() => {
        fetchReport();
    }, [fetchReport]);

    const handleSaveReport = async (input: SavedReportInput) => {
        const url = currentSavedReport
            ? `/api/reports/saved/${currentSavedReport.id}`
            : '/api/reports/saved';
        const method = currentSavedReport ? 'PUT' : 'POST';
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
        });
        if (!res.ok) throw new Error('Failed to save');
        const saved = await res.json();
        setCurrentSavedReport(saved);
        setSavedReportId(saved.id);
    };

    return (
        <div className="space-y-6">
            {/* Account Selection Section */}
            <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl overflow-hidden">
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <span className="text-sm font-semibold text-foreground-secondary uppercase tracking-wider">
                        Account Selection
                    </span>
                    <button
                        onClick={() => setIsSaveDialogOpen(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors"
                    >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                        </svg>
                        Save Configuration
                    </button>
                </div>
                <div className="p-4">
                    <p className="text-xs text-foreground-tertiary mb-3">
                        Select specific accounts to reconcile. Leave empty to include all accounts within the selected date range.
                    </p>
                    <AccountPicker
                        selectedGuids={selectedAccountGuids}
                        onChange={setSelectedAccountGuids}
                    />
                </div>
            </div>

            <ReportViewer
                title="Reconciliation Report"
                description="Reconciled, cleared, and uncleared transactions by account"
                filters={filters}
                onFilterChange={setFilters}
                isLoading={isLoading}
                error={error}
                showCompare={false}
                reportData={reportData ?? undefined}
            >
                {reportData && (
                    <ReportTable
                        sections={reportData.sections}
                        showComparison={false}
                    />
                )}
            </ReportViewer>

            <SaveReportDialog
                isOpen={isSaveDialogOpen}
                onClose={() => setIsSaveDialogOpen(false)}
                onSave={handleSaveReport}
                baseReportType={'reconciliation' as ReportType}
                existingReport={currentSavedReport}
                currentConfig={{
                    accountGuids: selectedAccountGuids,
                }}
                currentFilters={filters}
            />
        </div>
    );
}

export default function ReconciliationReportPage() {
    return (
        <Suspense fallback={<div className="p-8 text-center text-foreground-secondary">Loading...</div>}>
            <ReconciliationReportContent />
        </Suspense>
    );
}
