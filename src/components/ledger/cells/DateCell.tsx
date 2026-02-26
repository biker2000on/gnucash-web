'use client';
import { useRef, useEffect } from 'react';
import { useDateShortcuts } from '@/lib/hooks/useDateShortcuts';

interface DateCellProps {
    value: string;
    onChange: (value: string) => void;
    autoFocus?: boolean;
}

export function DateCell({ value, onChange, autoFocus }: DateCellProps) {
    const ref = useRef<HTMLInputElement>(null);
    const { handleDateKeyDown } = useDateShortcuts(value, onChange);

    useEffect(() => {
        if (autoFocus) ref.current?.focus();
    }, [autoFocus]);

    return (
        <input
            ref={ref}
            type="date"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleDateKeyDown}
            className="w-full bg-input-bg border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-cyan-500/50 font-mono"
        />
    );
}
