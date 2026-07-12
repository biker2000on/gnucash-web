'use client';

import { useCallback, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { RsuVestPanel } from './RsuVestPanel';
import { EsppPanel } from './EsppPanel';
import { EquityCompHistory } from './EquityCompHistory';

/**
 * Equity Compensation tracking: record RSU vest events (with sell-to-cover)
 * and ESPP purchases. Shares always enter at FMV cost basis — the vest value
 * / purchase discount is booked as compensation income, so gains are never
 * taxed twice.
 */
export default function EquityCompPage() {
    const [historyVersion, setHistoryVersion] = useState(0);
    const refreshHistory = useCallback(() => setHistoryVersion(v => v + 1), []);

    return (
        <div className="space-y-6">
            <PageHeader
                title="Equity Compensation"
                subtitle="Record RSU vests and ESPP purchases with FMV cost basis"
            />

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
                <RsuVestPanel onPosted={refreshHistory} />
                <EsppPanel onPosted={refreshHistory} />
            </div>

            <EquityCompHistory version={historyVersion} />
        </div>
    );
}
