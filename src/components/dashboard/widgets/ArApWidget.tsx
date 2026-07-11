'use client';

import { formatCurrency } from '@/lib/format';
import { WidgetShell, WidgetStat, useWidgetFetch } from './WidgetShell';

interface BusinessDashboardApi {
    ar: { total: number; count: number };
    ap: { total: number; count: number; dueWithin30: number };
}

/** Outstanding AR / AP (business books). Data: GET /api/business/reports/dashboard. */
export default function ArApWidget() {
    const { data, loading, error } = useWidgetFetch<BusinessDashboardApi>(
        '/api/business/reports/dashboard'
    );

    const empty = !!data && data.ar.count === 0 && data.ap.count === 0;

    return (
        <WidgetShell
            title="AR / AP"
            href="/business"
            loading={loading}
            error={error}
            empty={empty}
            emptyText="No open invoices or bills."
        >
            {data && (
                <div className="grid grid-cols-2 gap-3">
                    <WidgetStat
                        label="Receivable"
                        value={formatCurrency(data.ar.total)}
                        sub={`${data.ar.count} open invoice${data.ar.count === 1 ? '' : 's'}`}
                        toneClass="text-positive"
                    />
                    <WidgetStat
                        label="Payable"
                        value={formatCurrency(data.ap.total)}
                        sub={`${formatCurrency(data.ap.dueWithin30)} due in 30d`}
                        toneClass="text-negative"
                    />
                </div>
            )}
        </WidgetShell>
    );
}
