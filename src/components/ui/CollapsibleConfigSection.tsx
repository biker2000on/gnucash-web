'use client';

import { useState, ReactNode } from 'react';

interface CollapsibleConfigSectionProps {
    title: string;
    /**
     * One-line summary of the current configuration, shown while collapsed
     * (e.g. "12 accounts selected" or "2026 · Married Filing Jointly · CO").
     */
    summary?: ReactNode;
    /**
     * Whether the section has been configured. Unconfigured sections render
     * expanded and stay expanded; once configured the section defaults to
     * collapsed (respecting any stored user preference).
     */
    configured: boolean;
    /** localStorage key to remember the user's expand/collapse choice. */
    storageKey?: string;
    children: ReactNode;
    className?: string;
}

/**
 * A settings/setup panel that gets out of the way once configured: collapses
 * to a single summary row with a chevron, and can be reopened at any time to
 * change the configuration.
 */
export function CollapsibleConfigSection({
    title,
    summary,
    configured,
    storageKey,
    children,
    className = '',
}: CollapsibleConfigSectionProps) {
    // The user's expand/collapse choice. A section that mounts unconfigured
    // starts expanded and stays expanded after it becomes configured, until the
    // user hits Done.
    const [userOpen, setUserOpen] = useState(() => {
        if (!configured) return true;
        if (storageKey && typeof window !== 'undefined') {
            const saved = localStorage.getItem(storageKey);
            if (saved !== null) return saved === 'true';
        }
        return false;
    });

    // Derived, not synchronised: an unconfigured section has nothing to collapse
    // to, so it is always open regardless of the stored choice.
    const open = !configured || userOpen;

    const toggle = () => {
        if (!configured) return; // nothing to collapse to yet
        setUserOpen(o => {
            const next = !o;
            if (storageKey) {
                try {
                    localStorage.setItem(storageKey, String(next));
                } catch {
                    // localStorage unavailable; non-fatal
                }
            }
            return next;
        });
    };

    return (
        <div className={`bg-surface border border-border rounded-lg ${className}`}>
            <button
                onClick={toggle}
                disabled={!configured}
                aria-expanded={open}
                className={`w-full flex items-center justify-between gap-3 px-4 py-3 text-left ${
                    configured ? 'cursor-pointer hover:bg-surface-hover transition-colors rounded-lg' : 'cursor-default'
                }`}
            >
                <div className="min-w-0 flex items-baseline gap-3 flex-wrap">
                    <span className="text-sm font-semibold text-foreground">{title}</span>
                    {!open && summary && (
                        <span className="text-sm text-foreground-secondary truncate">{summary}</span>
                    )}
                </div>
                {configured && (
                    <span className="flex items-center gap-1.5 text-xs text-foreground-muted shrink-0">
                        {open ? 'Done' : 'Change'}
                        <svg
                            className={`w-4 h-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2}
                            viewBox="0 0 24 24"
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                    </span>
                )}
            </button>
            {open && <div className="px-4 pb-4 border-t border-border pt-3">{children}</div>}
        </div>
    );
}
