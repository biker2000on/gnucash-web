'use client';

import { formatCurrency } from '@/lib/format';
import { WidgetShell, WidgetStat, useWidgetFetch } from './WidgetShell';

interface SubscriptionsApi {
    totals: {
        activeCount: number;
        activeMonthlyTotal: number;
        activeAnnualTotal: number;
        priceIncreaseCount: number;
    };
}

/** Detected recurring charges. Data: GET /api/tools/subscriptions. */
export default function SubscriptionsWidget() {
    const { data, loading, error } = useWidgetFetch<SubscriptionsApi>('/api/tools/subscriptions');

    return (
        <WidgetShell
            title="Subscriptions"
            href="/tools/subscriptions"
            loading={loading}
            error={error}
            empty={!!data && data.totals.activeCount === 0}
            emptyText="No recurring charges detected."
        >
            {data && (
                <div className="grid grid-cols-2 gap-3">
                    <WidgetStat
                        label="Active"
                        value={data.totals.activeCount}
                        sub={
                            data.totals.priceIncreaseCount > 0
                                ? `${data.totals.priceIncreaseCount} price increase${
                                      data.totals.priceIncreaseCount === 1 ? '' : 's'
                                  }`
                                : 'No recent price increases'
                        }
                    />
                    <WidgetStat
                        label="Monthly"
                        value={formatCurrency(data.totals.activeMonthlyTotal)}
                        sub={`${formatCurrency(data.totals.activeAnnualTotal)} / yr`}
                    />
                </div>
            )}
        </WidgetShell>
    );
}
