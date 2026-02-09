'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { REPORTS, getReportsByCategory, ReportConfig, SavedReport, SavedReportInput, ReportType } from '@/lib/reports/types';
import SavedReportCard from '@/components/reports/SavedReportCard';
import SaveReportDialog from '@/components/reports/SaveReportDialog';

const CATEGORY_LABELS: Record<string, string> = {
    financial: 'Financial Statements',
    account: 'Account Reports',
    transaction: 'Transaction Reports',
};

const CATEGORY_ORDER = ['financial', 'account', 'transaction'];

function ReportIcon({ icon }: { icon: string }) {
    switch (icon) {
        case 'balance':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
                </svg>
            );
        case 'trending':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
            );
        case 'cash':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
            );
        case 'account':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
            );
        case 'list':
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                </svg>
            );
        default:
            return (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
            );
    }
}

function ReportCard({ report }: { report: ReportConfig }) {
    return (
        <Link
            href={`/reports/${report.type}`}
            className="group block bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6 hover:border-cyan-500/50 hover:bg-surface/50 transition-all duration-200"
        >
            <div className="flex items-start gap-4">
                <div className="p-3 bg-gradient-to-br from-cyan-500/20 to-emerald-500/20 rounded-xl text-cyan-400 group-hover:from-cyan-500/30 group-hover:to-emerald-500/30 transition-colors">
                    <ReportIcon icon={report.icon} />
                </div>
                <div className="flex-1 min-w-0">
                    <h3 className="text-lg font-semibold text-foreground group-hover:text-cyan-400 transition-colors">
                        {report.name}
                    </h3>
                    <p className="mt-1 text-sm text-foreground-muted line-clamp-2">
                        {report.description}
                    </p>
                </div>
                <div className="text-foreground-muted group-hover:text-cyan-400 transition-colors">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                </div>
            </div>
        </Link>
    );
}

export default function ReportsPage() {
    const reportsByCategory = getReportsByCategory();

    const [starredReports, setStarredReports] = useState<SavedReport[]>([]);
    const [savedReports, setSavedReports] = useState<SavedReport[]>([]);
    const [savedSearch, setSavedSearch] = useState('');
    const [editingReport, setEditingReport] = useState<SavedReport | null>(null);
    const [editDialogOpen, setEditDialogOpen] = useState(false);

    useEffect(() => {
        fetch('/api/reports/saved')
            .then(res => {
                if (!res.ok) return [];
                return res.json();
            })
            .then((reports: SavedReport[]) => {
                setStarredReports(reports.filter(r => r.isStarred));
                setSavedReports(reports.filter(r => !r.isStarred));
            })
            .catch(() => {
                // silently handle - user may not be authenticated
            });
    }, []);

    const handleToggleStar = async (id: number) => {
        // Find the report in either list
        const allSaved = [...starredReports, ...savedReports];
        const report = allSaved.find(r => r.id === id);
        if (!report) return;

        const wasStarred = report.isStarred;
        const updated = { ...report, isStarred: !wasStarred };

        // Optimistically update local state
        if (wasStarred) {
            setStarredReports(prev => prev.filter(r => r.id !== id));
            setSavedReports(prev => [...prev, updated]);
        } else {
            setSavedReports(prev => prev.filter(r => r.id !== id));
            setStarredReports(prev => [...prev, updated]);
        }

        try {
            await fetch(`/api/reports/saved/${id}/star`, { method: 'PATCH' });
        } catch {
            // Revert on failure
            if (wasStarred) {
                setSavedReports(prev => prev.filter(r => r.id !== id));
                setStarredReports(prev => [...prev, report]);
            } else {
                setStarredReports(prev => prev.filter(r => r.id !== id));
                setSavedReports(prev => [...prev, report]);
            }
        }
    };

    const handleDelete = async (id: number) => {
        setStarredReports(prev => prev.filter(r => r.id !== id));
        setSavedReports(prev => prev.filter(r => r.id !== id));

        try {
            await fetch(`/api/reports/saved/${id}`, { method: 'DELETE' });
        } catch {
            // Silently handle - item already removed from UI
        }
    };

    const handleEdit = (report: SavedReport) => {
        setEditingReport(report);
        setEditDialogOpen(true);
    };

    const handleSaveEdit = async (input: SavedReportInput) => {
        if (!editingReport) return;

        const res = await fetch(`/api/reports/saved/${editingReport.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
        });

        if (!res.ok) {
            throw new Error('Failed to update report');
        }

        const updated: SavedReport = await res.json();

        // Update local state
        if (updated.isStarred) {
            setStarredReports(prev => prev.map(r => r.id === updated.id ? updated : r));
            setSavedReports(prev => prev.filter(r => r.id !== updated.id));
            // If it was in non-starred and now starred, add to starred
            if (!starredReports.find(r => r.id === updated.id)) {
                setStarredReports(prev => [...prev, updated]);
            }
        } else {
            setSavedReports(prev => prev.map(r => r.id === updated.id ? updated : r));
            setStarredReports(prev => prev.filter(r => r.id !== updated.id));
            // If it was in starred and now non-starred, add to non-starred
            if (!savedReports.find(r => r.id === updated.id)) {
                setSavedReports(prev => [...prev, updated]);
            }
        }

        setEditDialogOpen(false);
        setEditingReport(null);
    };

    const filteredSavedReports = savedSearch
        ? savedReports.filter(r => r.name.toLowerCase().includes(savedSearch.toLowerCase()))
        : savedReports;

    return (
        <div className="space-y-8">
            <header>
                <h1 className="text-3xl font-bold text-foreground">Reports</h1>
                <p className="text-foreground-muted mt-1">
                    Generate financial reports and analyze your data.
                </p>
            </header>

            {/* Starred Reports */}
            {starredReports.length > 0 && (
                <section className="space-y-4">
                    <h2 className="text-lg font-semibold text-foreground-secondary uppercase tracking-wider flex items-center gap-2">
                        <svg className="w-5 h-5 text-yellow-400" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                        </svg>
                        Starred Reports
                    </h2>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {starredReports.map(report => (
                            <SavedReportCard
                                key={report.id}
                                report={report}
                                onToggleStar={handleToggleStar}
                                onEdit={handleEdit}
                                onDelete={handleDelete}
                            />
                        ))}
                    </div>
                </section>
            )}

            {/* Your Saved Reports */}
            {savedReports.length > 0 && (
                <section className="space-y-4">
                    <h2 className="text-lg font-semibold text-foreground-secondary uppercase tracking-wider">
                        Your Saved Reports
                    </h2>
                    <div className="relative max-w-sm">
                        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                        <input
                            type="text"
                            value={savedSearch}
                            onChange={(e) => setSavedSearch(e.target.value)}
                            placeholder="Search saved reports..."
                            className="w-full pl-10 pr-3 py-2 bg-input-bg border border-border rounded-lg text-foreground text-sm placeholder-foreground-tertiary focus:outline-none focus:ring-2 focus:ring-cyan-500"
                        />
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {filteredSavedReports.map(report => (
                            <SavedReportCard
                                key={report.id}
                                report={report}
                                onToggleStar={handleToggleStar}
                                onEdit={handleEdit}
                                onDelete={handleDelete}
                            />
                        ))}
                    </div>
                    {savedSearch && filteredSavedReports.length === 0 && (
                        <p className="text-sm text-foreground-tertiary">No saved reports match your search.</p>
                    )}
                </section>
            )}

            {/* Base Reports by Category */}
            {CATEGORY_ORDER.map(category => {
                const reports = reportsByCategory[category];
                if (!reports || reports.length === 0) return null;

                return (
                    <section key={category} className="space-y-4">
                        <h2 className="text-lg font-semibold text-foreground-secondary uppercase tracking-wider">
                            {CATEGORY_LABELS[category] || category}
                        </h2>
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            {reports.map(report => (
                                <ReportCard key={report.type} report={report} />
                            ))}
                        </div>
                    </section>
                );
            })}

            {/* Save Report Dialog (for editing) */}
            <SaveReportDialog
                isOpen={editDialogOpen}
                onClose={() => {
                    setEditDialogOpen(false);
                    setEditingReport(null);
                }}
                onSave={handleSaveEdit}
                baseReportType={editingReport?.baseReportType ?? ReportType.BALANCE_SHEET}
                existingReport={editingReport}
                currentConfig={editingReport?.config ?? {}}
                currentFilters={editingReport?.filters ?? undefined}
            />
        </div>
    );
}
