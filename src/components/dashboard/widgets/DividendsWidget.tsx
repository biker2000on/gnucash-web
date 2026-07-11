'use client';

import { formatCurrency } from '@/lib/format';
import { WidgetShell, WidgetStat, useWidgetFetch } from './WidgetShell';

interface DividendSummaryApi {
    ttmTotal: number;
    projectedNext12mo: number;
    portfolioYield: number | null;
    paymentCount: number;
}

/** Dividend income summary. Data: GET /api/investments/dividends. */
export default function DividendsWidget() {
    const { data, loading, error } = useWidgetFetch<DividendSummaryApi>(
        '/api/investments/dividends'
    );

    return (
        <WidgetShell
            title="Dividend Income"
            href="/investments/dividends"
            loading={loading}
            error={error}
            empty={!!data && data.paymentCount === 0}
            emptyText="No dividend payments detected yet."
        >
            {data && (
                <div className="grid grid-cols-2 gap-3">
                    <WidgetStat
                        label="Trailing 12mo"
                        value={formatCurrency(data.ttmTotal)}
                        sub={
                            data.portfolioYield != null
                                ? `${data.portfolioYield.toFixed(2)}% yield`
                                : undefined
                        }
                    />
                    <WidgetStat
                        label="Projected 12mo"
                        value={formatCurrency(data.projectedNext12mo)}
                        sub={`${data.paymentCount} payments recorded`}
                    />
                </div>
            )}
        </WidgetShell>
    );
}
