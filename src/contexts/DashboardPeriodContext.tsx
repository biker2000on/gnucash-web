"use client";

import { createContext, useContext, useState, useMemo, ReactNode } from 'react';
import { useUserPreferences, DashboardPeriod } from './UserPreferencesContext';
import { DATE_PRESETS } from '@/lib/datePresets';

const PERIOD_TO_LABEL: Record<DashboardPeriod, string> = {
    thisMonth: 'This Month',
    lastMonth: 'Last Month',
    thisQuarter: 'This Quarter',
    thisYear: 'This Year',
    lastYear: 'Last Year',
    allTime: 'All Time',
};

export const PERIOD_OPTIONS: { key: DashboardPeriod; label: string }[] = [
    { key: 'thisMonth', label: 'This Month' },
    { key: 'lastMonth', label: 'Last Month' },
    { key: 'thisQuarter', label: 'This Quarter' },
    { key: 'thisYear', label: 'This Year' },
    { key: 'lastYear', label: 'Last Year' },
    { key: 'allTime', label: 'All Time' },
];

function computeDateRange(period: DashboardPeriod): { startDate: string | null; endDate: string | null } {
    const label = PERIOD_TO_LABEL[period];
    const preset = DATE_PRESETS.find(p => p.label === label);
    if (!preset) return { startDate: null, endDate: null };
    return preset.getValue();
}

function buildQueryString(startDate: string | null, endDate: string | null): string {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    const qs = params.toString();
    return qs ? `?${qs}` : '';
}

interface DashboardPeriodContextType {
    period: DashboardPeriod;
    setPeriod: (p: DashboardPeriod) => void;
    startDate: string | null;
    endDate: string | null;
    queryString: string;
}

const DashboardPeriodContext = createContext<DashboardPeriodContextType | undefined>(undefined);

export function DashboardPeriodProvider({ children }: { children: ReactNode }) {
    const { dashboardDefaultPeriod } = useUserPreferences();
    const [period, setPeriod] = useState<DashboardPeriod>(dashboardDefaultPeriod);

    const { startDate, endDate } = useMemo(() => computeDateRange(period), [period]);
    const queryString = useMemo(() => buildQueryString(startDate, endDate), [startDate, endDate]);

    const value = useMemo<DashboardPeriodContextType>(() => ({
        period,
        setPeriod,
        startDate,
        endDate,
        queryString,
    }), [period, startDate, endDate, queryString]);

    return (
        <DashboardPeriodContext.Provider value={value}>
            {children}
        </DashboardPeriodContext.Provider>
    );
}

export function useDashboardPeriod() {
    const context = useContext(DashboardPeriodContext);
    if (context === undefined) {
        throw new Error('useDashboardPeriod must be used within a DashboardPeriodProvider');
    }
    return context;
}
