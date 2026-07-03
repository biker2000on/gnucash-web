'use client';

import { useState, useRef, useEffect, ReactNode } from 'react';

export interface ActionMenuItem {
    label: string;
    onSelect: () => void;
    icon?: ReactNode;
    /** Render in the destructive (red) style. */
    destructive?: boolean;
    disabled?: boolean;
}

interface ActionMenuProps {
    items: ActionMenuItem[];
    /** Accessible label for the trigger button. */
    label?: string;
    className?: string;
}

/**
 * Compact overflow ("...") menu for secondary page actions. Keeps headers
 * uncluttered: primary actions stay as buttons, everything else lives here.
 */
export function ActionMenu({ items, label = 'More actions', className = '' }: ActionMenuProps) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        function handleClickOutside(event: MouseEvent) {
            if (ref.current && !ref.current.contains(event.target as Node)) {
                setOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [open]);

    if (items.length === 0) return null;

    return (
        <div className={`relative ${className}`} ref={ref}>
            <button
                onClick={() => setOpen(o => !o)}
                aria-label={label}
                aria-expanded={open}
                title={label}
                className="flex items-center justify-center w-9 h-9 rounded-lg border border-border bg-surface/50 text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors"
            >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <circle cx="5" cy="12" r="1.75" />
                    <circle cx="12" cy="12" r="1.75" />
                    <circle cx="19" cy="12" r="1.75" />
                </svg>
            </button>
            {open && (
                <div className="absolute right-0 top-full mt-1 min-w-48 bg-surface-elevated border border-border rounded-lg shadow-xl z-50 py-1">
                    {items.map((item, i) => (
                        <button
                            key={i}
                            onClick={() => {
                                setOpen(false);
                                item.onSelect();
                            }}
                            disabled={item.disabled}
                            className={`flex items-center gap-2 w-full px-3 py-2 text-sm text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                                item.destructive
                                    ? 'text-negative hover:bg-negative/10'
                                    : 'text-foreground-secondary hover:text-foreground hover:bg-surface-hover'
                            }`}
                        >
                            {item.icon && <span className="w-4 h-4 shrink-0">{item.icon}</span>}
                            {item.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
