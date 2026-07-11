'use client';

import { WidgetShell, WidgetStat, useWidgetFetch } from './WidgetShell';

interface DataHealthApi {
    score: number;
    grade: string;
    checks?: Array<{ count: number }>;
}

function scoreTone(score: number): string {
    if (score >= 85) return 'text-positive';
    if (score >= 70) return 'text-warning';
    return 'text-negative';
}

/** Book data-quality score. Data: GET /api/tools/data-health. */
export default function DataHealthWidget() {
    const { data, loading, error } = useWidgetFetch<DataHealthApi>('/api/tools/data-health');

    const issueCount = Array.isArray(data?.checks)
        ? data.checks.reduce((s, c) => s + (typeof c.count === 'number' ? c.count : 0), 0)
        : null;

    return (
        <WidgetShell
            title="Data Health"
            href="/tools/data-health"
            loading={loading}
            error={error}
        >
            {data && (
                <div className="flex items-end justify-between gap-3">
                    <WidgetStat
                        label="Score"
                        value={`${Math.round(data.score)} / 100`}
                        sub={
                            issueCount != null
                                ? issueCount === 0
                                    ? 'No issues found'
                                    : `${issueCount} item${issueCount === 1 ? '' : 's'} flagged`
                                : undefined
                        }
                        toneClass={scoreTone(data.score)}
                    />
                    <span
                        className={`text-xs px-2 py-0.5 rounded-md border border-border ${scoreTone(data.score)}`}
                    >
                        {data.grade}
                    </span>
                </div>
            )}
        </WidgetShell>
    );
}
