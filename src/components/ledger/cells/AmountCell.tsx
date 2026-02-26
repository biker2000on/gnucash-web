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
}

export function AmountCell({ value, onChange, autoFocus }: AmountCellProps) {
    const ref = useRef<HTMLInputElement>(null);
    const { defaultTaxRate } = useUserPreferences();
    const { success } = useToast();
    const { applyTax } = useTaxShortcut(value, defaultTaxRate, onChange, (msg) => success(msg));

    useEffect(() => {
        if (autoFocus) ref.current?.focus();
    }, [autoFocus]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            applyTax();
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
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                placeholder="0.00"
                className="w-full bg-input-bg border border-border rounded px-2 py-1 text-xs text-foreground text-right focus:outline-none focus:border-cyan-500/50 font-mono"
            />
            {containsMathExpression(value) && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-cyan-400 pointer-events-none">=</span>
            )}
        </div>
    );
}
