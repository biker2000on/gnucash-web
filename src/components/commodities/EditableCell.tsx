'use client';

import { useEffect, useRef, useState } from 'react';

interface EditableCellProps {
    value: string;
    onChange: (next: string) => void;
    type?: 'text' | 'number';
    placeholder?: string;
    width?: string;
    align?: 'left' | 'right';
    mono?: boolean;
    upper?: boolean;
    /** Stable identifier used by the grid's arrow-key navigation. */
    cellId: string;
    /**
     * Called when editing exits via a navigation key.
     * - up/down/left/right: arrow keys; left/right clamp at row boundaries
     * - next/prev: Tab / Shift+Tab; wrap to next/prev row at boundaries
     */
    onArrowNav?: (direction: 'up' | 'down' | 'left' | 'right' | 'next' | 'prev') => void;
}

/**
 * Spreadsheet-style cell: renders as plain text by default, swaps to an
 * input on focus or click, commits on blur / Esc / Enter / Tab. Arrow keys
 * exit edit mode and bubble a navigation event up to the grid.
 */
export function EditableCell({
    value,
    onChange,
    type = 'text',
    placeholder = '—',
    width = 'w-32',
    align = 'left',
    mono = false,
    upper = false,
    cellId,
    onArrowNav,
}: EditableCellProps) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value);
    const inputRef = useRef<HTMLInputElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);

    const startEditing = (seed?: string) => {
        setDraft(seed ?? value);
        setEditing(true);
    };

    useEffect(() => {
        if (editing) {
            inputRef.current?.focus();
            inputRef.current?.select();
        }
    }, [editing]);

    const commit = () => {
        const next = upper ? draft.toUpperCase() : draft;
        if (next !== value) onChange(next);
        setEditing(false);
    };

    const cancel = () => {
        setDraft(value);
        setEditing(false);
    };

    const alignClass = align === 'right' ? 'text-right' : 'text-left';
    const fontClass = mono ? 'font-mono' : '';
    const baseClasses = `${width} ${alignClass} ${fontClass} text-sm`;

    if (editing) {
        return (
            <input
                ref={inputRef}
                data-cell={cellId}
                type={type}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        commit();
                        requestAnimationFrame(() => wrapperRef.current?.focus());
                    } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancel();
                        requestAnimationFrame(() => wrapperRef.current?.focus());
                    } else if (e.key === 'Tab') {
                        e.preventDefault();
                        commit();
                        requestAnimationFrame(() => {
                            onArrowNav?.(e.shiftKey ? 'prev' : 'next');
                        });
                    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                        e.preventDefault();
                        commit();
                        requestAnimationFrame(() => {
                            onArrowNav?.(e.key === 'ArrowUp' ? 'up' : 'down');
                        });
                    }
                }}
                placeholder={placeholder}
                className={`${baseClasses} bg-input-bg border border-primary/50 ring-1 ring-primary/20 rounded px-2 py-1 text-foreground focus:outline-none`}
            />
        );
    }

    const display = value ? (upper ? value.toUpperCase() : value) : '';

    return (
        <div
            ref={wrapperRef}
            data-cell={cellId}
            tabIndex={0}
            onFocus={() => startEditing()}
            onClick={() => startEditing()}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'F2') {
                    e.preventDefault();
                    startEditing();
                } else if (e.key === 'Backspace' || e.key === 'Delete') {
                    e.preventDefault();
                    startEditing('');
                } else if (
                    e.key.length === 1 &&
                    !e.ctrlKey &&
                    !e.metaKey &&
                    !e.altKey
                ) {
                    // Start editing on any printable key, seeding the draft
                    e.preventDefault();
                    startEditing(e.key);
                } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                    e.preventDefault();
                    const dir = e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : e.key === 'ArrowLeft' ? 'left' : 'right';
                    onArrowNav?.(dir);
                }
            }}
            className={`${baseClasses} cursor-text rounded px-2 py-1 text-foreground focus:outline-none focus:bg-primary/10 focus:ring-1 focus:ring-primary/40 hover:bg-surface-hover/40 truncate ${
                display ? '' : 'text-foreground-muted'
            }`}
            title={display || placeholder}
        >
            {display || placeholder}
        </div>
    );
}
