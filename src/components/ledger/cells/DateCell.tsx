'use client';
import { useState, useRef, useEffect } from 'react';
import { useDateShortcuts } from '@/lib/hooks/useDateShortcuts';
import { formatDateForDisplay, parseDateInput } from '@/lib/date-format';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';

interface DateCellProps {
    value: string;
    onChange: (value: string) => void;
    autoFocus?: boolean;
    onEnter?: () => void;
    onArrowUp?: () => void;
    onArrowDown?: () => void;
    onFocus?: () => void;
}

export function DateCell({ value, onChange, autoFocus, onEnter, onArrowUp, onArrowDown, onFocus }: DateCellProps) {
    const { dateFormat: format } = useUserPreferences();
    const [displayValue, setDisplayValue] = useState(() => formatDateForDisplay(value, format));
    const ref = useRef<HTMLInputElement>(null);
    const { handleDateKeyDown } = useDateShortcuts(value, (newIso) => {
        onChange(newIso);
        setDisplayValue(formatDateForDisplay(newIso, format));
    });

    useEffect(() => {
        setDisplayValue(formatDateForDisplay(value, format));
    }, [value]);

    useEffect(() => {
        if (autoFocus) {
            ref.current?.focus();
            ref.current?.select();
        }
    }, [autoFocus]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            onEnter?.();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            onArrowUp?.();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            onArrowDown?.();
        } else {
            handleDateKeyDown(e);
        }
    };

    const handleBlur = () => {
        const parsed = parseDateInput(displayValue);
        if (parsed) {
            onChange(parsed);
            setDisplayValue(formatDateForDisplay(parsed, format));
        } else {
            setDisplayValue(formatDateForDisplay(value, format));
        }
    };

    return (
        <input
            ref={ref}
            type="text"
            value={displayValue}
            onChange={(e) => setDisplayValue(e.target.value)}
            onFocus={() => { ref.current?.select(); onFocus?.(); }}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            placeholder="MM/DD/YYYY"
            className="w-full bg-input-bg border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-cyan-500/50 font-mono"
        />
    );
}
