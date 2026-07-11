'use client';

import { useMemo } from 'react';
import { formatCurrency } from '@/lib/format';
import { CustomWidgetDef, describeCustomWidget } from '@/lib/dashboard-widgets';
import { WidgetShell, useWidgetFetch, TNUM } from './WidgetShell';

interface CustomWidgetResult {
    value: number;
    accountCount: number;
}

/**
 * Renders a user-defined stat widget by evaluating its definition through
 * GET /api/dashboard/custom-widget (book-scoped, server-computed).
 */
export default function CustomWidget({ def }: { def: CustomWidgetDef }) {
    const url = useMemo(() => {
        const params = new URLSearchParams();
        params.set('ids', def.config.accountGuids.join(','));
        params.set('mode', def.config.mode);
        if (def.config.mode === 'spend') {
            params.set('days', String(def.config.days ?? 90));
        }
        return `/api/dashboard/custom-widget?${params.toString()}`;
    }, [def]);

    const { data, loading, error } = useWidgetFetch<CustomWidgetResult>(url);

    const tone = !data
        ? 'text-foreground'
        : def.config.toneBySign
            ? data.value > 0.004
                ? 'text-positive'
                : data.value < -0.004
                    ? 'text-negative'
                    : 'text-foreground'
            : 'text-foreground';

    return (
        <WidgetShell
            title={def.name}
            href="/accounts"
            hrefLabel="Accounts"
            loading={loading}
            error={error}
            empty={!!data && data.accountCount === 0}
            emptyText="None of this widget's accounts exist in the active book."
        >
            {data && (
                <div>
                    <div
                        className={`font-mono font-semibold tabular-nums text-2xl ${tone}`}
                        style={TNUM}
                    >
                        {formatCurrency(data.value)}
                    </div>
                    <div className="mt-1 text-[11px] text-foreground-muted">
                        {describeCustomWidget(def)}
                    </div>
                </div>
            )}
        </WidgetShell>
    );
}
