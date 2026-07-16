'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { TimeProject } from '@/lib/timesheet';

interface ProjectSelectProps {
    projects: TimeProject[];
    /** Selected project key ('' for none). */
    value: string;
    onChange: (key: string, project: TimeProject | null) => void;
    placeholder?: string;
    allowNone?: boolean;
    disabled?: boolean;
    compact?: boolean;
    autoFocus?: boolean;
}

/**
 * Searchable project (customer / customer—job) picker fed by
 * /api/business/time/projects. Local filtering, keyboard navigation.
 */
export function ProjectSelect({
    projects,
    value,
    onChange,
    placeholder = 'Select project…',
    allowNone = true,
    disabled = false,
    compact = false,
    autoFocus = false,
}: ProjectSelectProps) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [focusedIndex, setFocusedIndex] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const selected = useMemo(() => projects.find((p) => p.key === value) ?? null, [projects, value]);

    useEffect(() => {
        if (autoFocus) inputRef.current?.focus();
    }, [autoFocus]);

    useEffect(() => {
        if (!open) return;
        const onDocClick = (e: MouseEvent) => {
            if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDocClick);
        return () => document.removeEventListener('mousedown', onDocClick);
    }, [open]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return projects;
        return projects.filter((p) => p.label.toLowerCase().includes(q));
    }, [projects, search]);

    // Options: optional "No project" + filtered projects.
    const options: Array<TimeProject | null> = useMemo(
        () => (allowNone ? [null, ...filtered] : [...filtered]),
        [allowNone, filtered],
    );

    // Reset the highlight whenever the option list context changes (open /
    // search) — done from the event handlers below rather than an effect.

    useEffect(() => {
        const el = listRef.current?.children[focusedIndex] as HTMLElement | undefined;
        el?.scrollIntoView({ block: 'nearest' });
    }, [focusedIndex]);

    const select = (p: TimeProject | null) => {
        onChange(p?.key ?? '', p);
        setSearch('');
        setOpen(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (!open) {
            if (e.key === 'ArrowDown' || e.key === 'Enter') {
                setOpen(true);
                e.preventDefault();
            }
            return;
        }
        switch (e.key) {
            case 'ArrowDown':
                setFocusedIndex((i) => Math.min(i + 1, options.length - 1));
                e.preventDefault();
                break;
            case 'ArrowUp':
                setFocusedIndex((i) => Math.max(i - 1, 0));
                e.preventDefault();
                break;
            case 'Enter':
                if (options[focusedIndex] !== undefined) select(options[focusedIndex]);
                e.preventDefault();
                break;
            case 'Escape':
                setOpen(false);
                e.preventDefault();
                e.stopPropagation();
                break;
        }
    };

    return (
        <div ref={containerRef} className="relative">
            <div
                className={`flex items-center bg-input-bg border rounded-lg ${compact ? 'px-2 py-1' : 'px-3 py-2'} ${
                    disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-border-hover'
                } ${open ? 'border-primary/50 ring-1 ring-primary/20' : 'border-border'}`}
                onClick={() => !disabled && inputRef.current?.focus()}
            >
                <input
                    ref={inputRef}
                    type="text"
                    value={open ? search : (selected?.label ?? '')}
                    onChange={(e) => {
                        setSearch(e.target.value);
                        setFocusedIndex(0);
                        if (!open) setOpen(true);
                    }}
                    onFocus={() => {
                        setSearch('');
                        setFocusedIndex(0);
                        setOpen(true);
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    disabled={disabled}
                    className={`flex-1 min-w-0 bg-transparent ${compact ? 'text-xs' : 'text-sm'} text-foreground placeholder-foreground-muted focus:outline-none`}
                />
                <svg
                    className={`${compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} shrink-0 text-foreground-muted transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </div>

            {open && (
                <div
                    ref={listRef}
                    className="absolute z-50 mt-1 left-0 right-0 min-w-[220px] max-h-56 overflow-y-auto bg-surface-elevated border border-border rounded-md shadow-lg"
                >
                    {options.length === 0 && (
                        <div className="px-3 py-3 text-center text-xs text-foreground-muted">No projects found</div>
                    )}
                    {options.map((p, i) => (
                        <div
                            key={p?.key ?? '__none'}
                            className={`px-3 py-1.5 text-sm cursor-pointer truncate ${
                                i === focusedIndex ? 'bg-primary/20 text-foreground'
                                : (p?.key ?? '') === value ? 'bg-primary/10 text-foreground'
                                : 'text-foreground-secondary hover:bg-surface-hover'
                            }`}
                            onMouseEnter={() => setFocusedIndex(i)}
                            onMouseDown={(e) => { e.preventDefault(); select(p); }}
                        >
                            {p ? p.label : <span className="text-foreground-muted">No project</span>}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
