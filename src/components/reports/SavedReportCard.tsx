'use client';

import Link from 'next/link';
import { useState } from 'react';
import { SavedReport, REPORTS } from '@/lib/reports/types';

interface SavedReportCardProps {
    report: SavedReport;
    onToggleStar: (id: number) => void;
    onEdit: (report: SavedReport) => void;
    onDelete: (id: number) => void;
}

function getRelativeTime(dateString: string): string {
    const now = Date.now();
    const then = new Date(dateString).getTime();
    const diffMs = now - then;
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);
    const diffWeeks = Math.floor(diffDays / 7);
    const diffMonths = Math.floor(diffDays / 30);

    if (diffSeconds < 60) return 'just now';
    if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
    if (diffWeeks < 5) return `${diffWeeks} week${diffWeeks === 1 ? '' : 's'} ago`;
    return `${diffMonths} month${diffMonths === 1 ? '' : 's'} ago`;
}

export default function SavedReportCard({ report, onToggleStar, onEdit, onDelete }: SavedReportCardProps) {
    const [confirmingDelete, setConfirmingDelete] = useState(false);

    const baseReport = REPORTS.find(r => r.type === report.baseReportType);
    const displayName = baseReport?.name ?? report.baseReportType;

    const href = report.baseReportType === 'treasurer'
        ? `/reports/treasurer?savedId=${report.id}`
        : `/reports/${report.baseReportType}`;

    return (
        <div className="relative bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl p-5 hover:border-cyan-500/50 transition-all group">
            {/* Star button */}
            <button
                onClick={() => onToggleStar(report.id)}
                className="absolute top-4 right-4 text-foreground-tertiary hover:text-yellow-400 transition-colors"
                title={report.isStarred ? 'Unstar' : 'Star'}
            >
                {report.isStarred ? (
                    <svg className="w-5 h-5 text-yellow-400" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                    </svg>
                ) : (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                    </svg>
                )}
            </button>

            {/* Report name as link */}
            <Link href={href} className="block mb-2 pr-8">
                <h3 className="text-base font-semibold text-foreground group-hover:text-cyan-400 transition-colors truncate">
                    {report.name}
                </h3>
            </Link>

            {/* Description */}
            {report.description && (
                <p className="text-sm text-foreground-muted line-clamp-2 mb-3">
                    {report.description}
                </p>
            )}

            {/* Badge and time */}
            <div className="flex items-center gap-2 mb-4">
                <span className="px-2 py-0.5 text-xs rounded-full bg-cyan-500/10 text-cyan-400">
                    {displayName}
                </span>
                <span className="text-xs text-foreground-tertiary">
                    {getRelativeTime(report.updatedAt)}
                </span>
            </div>

            {/* Footer actions */}
            {confirmingDelete ? (
                <div className="flex items-center gap-2 text-sm">
                    <span className="text-foreground-muted">Are you sure?</span>
                    <button
                        onClick={() => {
                            onDelete(report.id);
                            setConfirmingDelete(false);
                        }}
                        className="px-2 py-0.5 text-xs rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                    >
                        Confirm
                    </button>
                    <button
                        onClick={() => setConfirmingDelete(false)}
                        className="px-2 py-0.5 text-xs rounded bg-surface text-foreground-muted hover:text-foreground transition-colors"
                    >
                        Cancel
                    </button>
                </div>
            ) : (
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => onEdit(report)}
                        className="text-foreground-tertiary hover:text-foreground transition-colors"
                        title="Edit"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                    </button>
                    <button
                        onClick={() => setConfirmingDelete(true)}
                        className="text-foreground-tertiary hover:text-red-400 transition-colors"
                        title="Delete"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                    </button>
                </div>
            )}
        </div>
    );
}
