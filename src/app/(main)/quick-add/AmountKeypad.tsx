'use client';

/**
 * Thumb-friendly amount keypad for the quick-add screen.
 * Manages a decimal string (max 2 decimal places) via big touch targets.
 */

interface AmountKeypadProps {
    value: string;
    onChange: (value: string) => void;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'backspace'] as const;

export function applyKey(current: string, key: string): string {
    if (key === 'backspace') {
        return current.slice(0, -1);
    }
    if (key === '.') {
        if (current.includes('.')) return current;
        return current === '' ? '0.' : current + '.';
    }
    // Digit
    if (current === '0') return key; // no leading zeros
    const dotIndex = current.indexOf('.');
    if (dotIndex !== -1 && current.length - dotIndex > 2) return current; // max 2 decimals
    if (dotIndex === -1 && current.length >= 7) return current; // sanity cap on whole part
    return current + key;
}

export function AmountKeypad({ value, onChange }: AmountKeypadProps) {
    return (
        <div className="grid grid-cols-3 gap-2" role="group" aria-label="Amount keypad">
            {KEYS.map(key => (
                <button
                    key={key}
                    type="button"
                    onClick={() => onChange(applyKey(value, key))}
                    aria-label={key === 'backspace' ? 'Delete last digit' : key}
                    className="h-14 min-h-[44px] rounded-lg bg-surface border border-border text-foreground text-xl font-mono font-medium active:bg-surface-hover hover:border-border-hover transition-colors flex items-center justify-center select-none"
                >
                    {key === 'backspace' ? (
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M12 9.75L14.25 12m0 0l2.25 2.25M14.25 12l2.25-2.25M14.25 12L12 14.25m-2.58 4.92l-6.374-6.375a1.125 1.125 0 010-1.59L9.42 4.83c.211-.211.498-.33.796-.33H19.5a2.25 2.25 0 012.25 2.25v10.5a2.25 2.25 0 01-2.25 2.25h-9.284c-.298 0-.585-.119-.796-.33z"
                            />
                        </svg>
                    ) : (
                        key
                    )}
                </button>
            ))}
        </div>
    );
}
