'use client';

import { useState, useRef, useEffect } from 'react';
import { DATE_PRESETS, DateRange, formatDateForDisplay } from '@/lib/datePresets';
import { formatDateForDisplay as formatIsoToDisplay, parseDateInput } from '@/lib/date-format';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';

interface DateRangePickerProps {
    startDate: string | null;
    endDate: string | null;
    onChange: (range: DateRange) => void;
    className?: string;
}

export function DateRangePicker({ startDate, endDate, onChange, className = '' }: DateRangePickerProps) {
    const { dateFormat } = useUserPreferences();
    const [isOpen, setIsOpen] = useState(false);
    const [customStart, setCustomStart] = useState(startDate || '');
    const [customEnd, setCustomEnd] = useState(endDate || '');
    const [customStartDisplay, setCustomStartDisplay] = useState(() => startDate ? formatIsoToDisplay(startDate, dateFormat) : '');
    const [customEndDisplay, setCustomEndDisplay] = useState(() => endDate ? formatIsoToDisplay(endDate, dateFormat) : '');
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Update custom inputs when props change
    useEffect(() => {
        setCustomStart(startDate || '');
        setCustomEnd(endDate || '');
        setCustomStartDisplay(startDate ? formatIsoToDisplay(startDate, dateFormat) : '');
        setCustomEndDisplay(endDate ? formatIsoToDisplay(endDate, dateFormat) : '');
    }, [startDate, endDate, dateFormat]);

    // Close dropdown when clicking outside
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handlePresetClick = (preset: typeof DATE_PRESETS[0]) => {
        const range = preset.getValue();
        onChange(range);
        setIsOpen(false);
    };

    const handleCustomApply = () => {
        onChange({
            startDate: customStart || null,
            endDate: customEnd || null
        });
        setIsOpen(false);
    };

    const getCurrentLabel = (): string => {
        if (!startDate && !endDate) return 'All Time';

        // Check if current range matches a preset
        for (const preset of DATE_PRESETS) {
            const { startDate: ps, endDate: pe } = preset.getValue();
            if (ps === startDate && pe === endDate) {
                return preset.label;
            }
        }

        // Custom range
        if (startDate && endDate) {
            return `${formatDateForDisplay(startDate)} - ${formatDateForDisplay(endDate)}`;
        } else if (startDate) {
            return `From ${formatDateForDisplay(startDate)}`;
        } else if (endDate) {
            return `Until ${formatDateForDisplay(endDate)}`;
        }

        return 'Custom';
    };

    return (
        <div className={`relative ${className}`} ref={dropdownRef}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center gap-2 bg-surface/50 border border-border rounded-xl px-4 py-2 text-sm text-foreground hover:border-emerald-500/50 transition-all"
            >
                <svg className="w-4 h-4 text-foreground-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span>{getCurrentLabel()}</span>
                <svg className={`w-4 h-4 text-foreground-secondary transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </button>

            {isOpen && (
                <div className="absolute top-full left-0 mt-2 w-80 bg-background-secondary border border-border rounded-xl shadow-xl z-50 overflow-hidden">
                    {/* Presets */}
                    <div className="p-2 border-b border-border">
                        <div className="text-xs text-foreground-muted uppercase tracking-wider px-2 py-1">Quick Select</div>
                        <div className="grid grid-cols-2 gap-1">
                            {DATE_PRESETS.map((preset) => {
                                const { startDate: ps, endDate: pe } = preset.getValue();
                                const isActive = ps === startDate && pe === endDate;
                                return (
                                    <button
                                        key={preset.label}
                                        onClick={() => handlePresetClick(preset)}
                                        className={`px-3 py-2 text-sm rounded-lg text-left transition-colors ${
                                            isActive
                                                ? 'bg-emerald-500/20 text-emerald-400'
                                                : 'text-foreground-secondary hover:bg-surface-hover'
                                        }`}
                                    >
                                        {preset.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* Custom Range */}
                    <div className="p-3">
                        <div className="text-xs text-foreground-muted uppercase tracking-wider mb-2">Custom Range</div>
                        <div className="flex gap-2 items-center mb-3">
                            <input
                                type="text"
                                value={customStartDisplay}
                                onChange={(e) => setCustomStartDisplay(e.target.value)}
                                onFocus={(e) => e.target.select()}
                                onBlur={() => {
                                    const parsed = parseDateInput(customStartDisplay);
                                    if (parsed) {
                                        setCustomStart(parsed);
                                        setCustomStartDisplay(formatIsoToDisplay(parsed, dateFormat));
                                    } else if (!customStartDisplay.trim()) {
                                        setCustomStart('');
                                    } else {
                                        setCustomStartDisplay(customStart ? formatIsoToDisplay(customStart, dateFormat) : '');
                                    }
                                }}
                                placeholder="MM/DD/YYYY"
                                className="flex-1 bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-emerald-500/50"
                            />
                            <span className="text-foreground-muted">to</span>
                            <input
                                type="text"
                                value={customEndDisplay}
                                onChange={(e) => setCustomEndDisplay(e.target.value)}
                                onFocus={(e) => e.target.select()}
                                onBlur={() => {
                                    const parsed = parseDateInput(customEndDisplay);
                                    if (parsed) {
                                        setCustomEnd(parsed);
                                        setCustomEndDisplay(formatIsoToDisplay(parsed, dateFormat));
                                    } else if (!customEndDisplay.trim()) {
                                        setCustomEnd('');
                                    } else {
                                        setCustomEndDisplay(customEnd ? formatIsoToDisplay(customEnd, dateFormat) : '');
                                    }
                                }}
                                placeholder="MM/DD/YYYY"
                                className="flex-1 bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-emerald-500/50"
                            />
                        </div>
                        <button
                            onClick={handleCustomApply}
                            className="w-full bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium py-2 rounded-lg transition-colors"
                        >
                            Apply
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
