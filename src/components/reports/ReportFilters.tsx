'use client';

import { useState } from 'react';
import { ReportFilters as ReportFiltersType } from '@/lib/reports/types';
import { formatDateForDisplay, parseDateInput } from '@/lib/date-format';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { FilterBar } from '@/components/ui/FilterBar';

interface ReportFiltersProps {
    filters: ReportFiltersType;
    onChange: (filters: ReportFiltersType) => void;
    showCompare?: boolean;
    showAccountTypes?: boolean;
    /** Show the Accrual/Cash basis select (income-statement style reports). */
    showBasis?: boolean;
}

const PRESETS = [
    { label: 'This Month', getValue: () => getThisMonth() },
    { label: 'Last Month', getValue: () => getLastMonth() },
    { label: 'This Quarter', getValue: () => getThisQuarter() },
    { label: 'This Year', getValue: () => getThisYear() },
    { label: 'Last Year', getValue: () => getLastYear() },
] as const;

function getThisMonth() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return {
        startDate: start.toISOString().split('T')[0],
        endDate: end.toISOString().split('T')[0],
    };
}

function getLastMonth() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    return {
        startDate: start.toISOString().split('T')[0],
        endDate: end.toISOString().split('T')[0],
    };
}

function getThisQuarter() {
    const now = new Date();
    const quarter = Math.floor(now.getMonth() / 3);
    const start = new Date(now.getFullYear(), quarter * 3, 1);
    const end = new Date(now.getFullYear(), quarter * 3 + 3, 0);
    return {
        startDate: start.toISOString().split('T')[0],
        endDate: end.toISOString().split('T')[0],
    };
}

function getThisYear() {
    const now = new Date();
    return {
        startDate: `${now.getFullYear()}-01-01`,
        endDate: `${now.getFullYear()}-12-31`,
    };
}

function getLastYear() {
    const now = new Date();
    const year = now.getFullYear() - 1;
    return {
        startDate: `${year}-01-01`,
        endDate: `${year}-12-31`,
    };
}

export function ReportFilters({ filters, onChange, showCompare = true, showAccountTypes = false, showBasis = false }: ReportFiltersProps) {
    const filtersKey = `${filters.startDate ?? ''}|${filters.endDate ?? ''}|${filters.compareToPrevious ?? false}|${filters.basis ?? 'accrual'}|${showCompare}|${showAccountTypes}|${showBasis}`;

    return (
        <ReportFiltersForm
            key={filtersKey}
            filters={filters}
            onChange={onChange}
            showCompare={showCompare}
            showAccountTypes={showAccountTypes}
            showBasis={showBasis}
        />
    );
}

function ReportFiltersForm({ filters, onChange, showCompare = true, showBasis = false }: ReportFiltersProps) {
    const { dateFormat } = useUserPreferences();
    const [localFilters, setLocalFilters] = useState(filters);
    const [startDateDisplay, setStartDateDisplay] = useState(() => filters.startDate ? formatDateForDisplay(filters.startDate, dateFormat) : '');
    const [endDateDisplay, setEndDateDisplay] = useState(() => filters.endDate ? formatDateForDisplay(filters.endDate, dateFormat) : '');

    const handlePreset = (preset: typeof PRESETS[number]) => {
        const { startDate, endDate } = preset.getValue();
        const newFilters = { ...localFilters, startDate, endDate };
        setLocalFilters(newFilters);
        setStartDateDisplay(startDate ? formatDateForDisplay(startDate, dateFormat) : '');
        setEndDateDisplay(endDate ? formatDateForDisplay(endDate, dateFormat) : '');
        onChange(newFilters);
    };

    const handleApply = () => {
        onChange(localFilters);
    };

    const handleReset = () => {
        const thisYear = getThisYear();
        const newFilters: ReportFiltersType = {
            startDate: thisYear.startDate,
            endDate: thisYear.endDate,
            compareToPrevious: false,
        };
        setLocalFilters(newFilters);
        onChange(newFilters);
    };

    const isActive = (preset: typeof PRESETS[number]) => {
        const { startDate, endDate } = preset.getValue();
        return localFilters.startDate === startDate && localFilters.endDate === endDate;
    };

    const applyResetButtons = (
        <>
            <button
                onClick={handleReset}
                className="px-3 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
            >
                Reset
            </button>
            <button
                onClick={handleApply}
                className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors"
            >
                Apply
            </button>
        </>
    );

    return (
        <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl p-4">
            <FilterBar
                activeCount={showCompare && localFilters.compareToPrevious ? 1 : 0}
                primary={
                    /* Date Range — always visible */
                    <div className="grid grid-cols-2 gap-2 flex-1 min-w-0 md:flex md:flex-none md:gap-3">
                        <div className="min-w-0">
                            <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                                Start Date
                            </label>
                            <input
                                type="text"
                                value={startDateDisplay}
                                onChange={e => setStartDateDisplay(e.target.value)}
                                onFocus={(e) => e.target.select()}
                                onBlur={() => {
                                    const parsed = parseDateInput(startDateDisplay);
                                    if (parsed) {
                                        setLocalFilters(prev => ({ ...prev, startDate: parsed }));
                                        setStartDateDisplay(formatDateForDisplay(parsed, dateFormat));
                                    } else if (!startDateDisplay.trim()) {
                                        setLocalFilters(prev => ({ ...prev, startDate: null }));
                                    } else {
                                        setStartDateDisplay(localFilters.startDate ? formatDateForDisplay(localFilters.startDate, dateFormat) : '');
                                    }
                                }}
                                placeholder="MM/DD/YYYY"
                                className="w-full md:w-auto bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                            />
                        </div>
                        <div className="min-w-0">
                            <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                                End Date
                            </label>
                            <input
                                type="text"
                                value={endDateDisplay}
                                onChange={e => setEndDateDisplay(e.target.value)}
                                onFocus={(e) => e.target.select()}
                                onBlur={() => {
                                    const parsed = parseDateInput(endDateDisplay);
                                    if (parsed) {
                                        setLocalFilters(prev => ({ ...prev, endDate: parsed }));
                                        setEndDateDisplay(formatDateForDisplay(parsed, dateFormat));
                                    } else if (!endDateDisplay.trim()) {
                                        setLocalFilters(prev => ({ ...prev, endDate: null }));
                                    } else {
                                        setEndDateDisplay(localFilters.endDate ? formatDateForDisplay(localFilters.endDate, dateFormat) : '');
                                    }
                                }}
                                placeholder="MM/DD/YYYY"
                                className="w-full md:w-auto bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                            />
                        </div>
                        {showBasis && (
                            <div className="min-w-0">
                                <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                                    Basis
                                </label>
                                <select
                                    value={localFilters.basis ?? 'accrual'}
                                    onChange={e => {
                                        const basis = e.target.value === 'cash' ? 'cash' as const : 'accrual' as const;
                                        const newFilters = { ...localFilters, basis };
                                        setLocalFilters(newFilters);
                                        onChange(newFilters);
                                    }}
                                    className="w-full md:w-auto bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                                >
                                    <option value="accrual">Accrual</option>
                                    <option value="cash">Cash</option>
                                </select>
                            </div>
                        )}
                    </div>
                }
            >
                {/* Quick Presets */}
                <div className="flex flex-wrap gap-1">
                    {PRESETS.map(preset => (
                        <button
                            key={preset.label}
                            onClick={() => handlePreset(preset)}
                            className={`px-3 py-2 text-xs rounded-lg transition-colors ${
                                isActive(preset)
                                    ? 'bg-primary/20 text-primary border border-primary/30'
                                    : 'bg-background-tertiary text-foreground-secondary hover:text-foreground'
                            }`}
                        >
                            {preset.label}
                        </button>
                    ))}
                </div>

                {/* Compare Toggle */}
                {showCompare && (
                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={localFilters.compareToPrevious || false}
                            onChange={e => setLocalFilters(prev => ({ ...prev, compareToPrevious: e.target.checked }))}
                            className="w-4 h-4 rounded border-border-hover bg-background text-primary focus:ring-primary/50"
                        />
                        <span className="text-sm text-foreground-secondary">Compare to previous period</span>
                    </label>
                )}

                {/* Apply/Reset — inline on desktop */}
                <div className="hidden md:flex gap-2 md:ml-auto">{applyResetButtons}</div>
            </FilterBar>

            {/* Apply/Reset — always visible on mobile, below the bar */}
            <div className="flex md:hidden justify-end gap-2 mt-3">{applyResetButtons}</div>
        </div>
    );
}
