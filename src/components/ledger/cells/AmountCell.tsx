'use client';
import { useRef, useEffect } from 'react';
import { useTaxShortcut } from '@/lib/hooks/useTaxShortcut';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { useToast } from '@/contexts/ToastContext';
import { evaluateMathExpression, containsMathExpression } from '@/lib/math-eval';

interface AmountCellProps {
    value: string;
    onChange: (value: string) => void;
    autoFocus?: boolean;
    onEnter?: () => void;
    onArrowUp?: () => void;
    onArrowDown?: () => void;
    onFocus?: () => void;
    onTab?: () => void;
    onShiftTab?: () => void;
}

export function AmountCell({ value, onChange, autoFocus, onEnter, onArrowUp, onArrowDown, onFocus, onTab, onShiftTab }: AmountCellProps) {
    const ref = useRef<HTMLInputElement>(null);
    const { defaultTaxRate } = useUserPreferences();
    const { success } = useToast();
    const { applyTax } = useTaxShortcut(value, defaultTaxRate, onChange, (msg) => success(msg));

    useEffect(() => {
        if (autoFocus && ref.current) {
            ref.current.focus();
            // Select the whole value so typing overwrites rather than appends.
            // Wrapped in RAF so it runs after the focus paint.
            requestAnimationFrame(() => ref.current?.select());
        }
    }, [autoFocus]);

    const handleFocus = () => {
        // Also select on plain focus (mouse click or Tab from another cell).
        ref.current?.select();
        onFocus?.();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            applyTax();
        } else if (e.key === 'Enter') {
            const result = evaluateMathExpression(value);
            if (result !== null) onChange(result.toFixed(2));
            e.preventDefault();
            onEnter?.();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            onArrowUp?.();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            onArrowDown?.();
        } else if (e.key === 'Tab' && !e.shiftKey && onTab) {
            e.preventDefault();
            const result = evaluateMathExpression(value);
            if (result !== null) onChange(result.toFixed(2));
            onTab();
        } else if (e.key === 'Tab' && e.shiftKey && onShiftTab) {
            e.preventDefault();
            const result = evaluateMathExpression(value);
            if (result !== null) onChange(result.toFixed(2));
            onShiftTab();
        }
    };

    const handleBlur = () => {
        const result = evaluateMathExpression(value);
        if (result !== null) {
            onChange(result.toFixed(2));
        }
    };

    return (
        <div className="relative">
            <input
                ref={ref}
                type="text"
                inputMode="decimal"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onFocus={handleFocus}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                placeholder="0.00"
                className="w-full bg-input-bg border border-border rounded px-2 py-0.5 text-xs text-foreground text-right focus:outline-none focus:border-primary/50 font-mono leading-tight"
            />
            {containsMathExpression(value) && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-primary pointer-events-none">=</span>
            )}
        </div>
    );
}
