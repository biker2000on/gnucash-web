'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface NamespaceSelectorProps {
    value: string;
    options: string[];
    onChange: (value: string) => void;
    placeholder?: string;
    className?: string;
    compact?: boolean;
    /** When true, the trigger looks like plain text until focused/open. */
    borderless?: boolean;
    /** Optional id used by the grid's arrow-key navigation. */
    cellId?: string;
    onArrowNav?: (direction: 'up' | 'down' | 'left' | 'right' | 'next' | 'prev') => void;
}

/**
 * Click-to-open namespace dropdown for commodities. Always shows the full
 * list on open (the option set is short), allows free-text entry for custom
 * namespaces, and supports keyboard navigation. Renders via portal so it
 * escapes any parent `overflow-hidden` (e.g. the bulk table's scroll container).
 */
export function NamespaceSelector({
    value,
    options,
    onChange,
    placeholder = 'Namespace',
    className = '',
    compact = false,
    borderless = false,
    cellId,
    onArrowNav,
}: NamespaceSelectorProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

    useEffect(() => {
        if (isOpen && containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            const maxDropdownHeight = 240;
            const spaceBelow = window.innerHeight - rect.bottom;
            const spaceAbove = rect.top;
            const openUpward = spaceBelow < maxDropdownHeight && spaceAbove > spaceBelow;
            const minWidth = 160;
            const dropdownWidth = Math.max(rect.width, minWidth);
            const maxLeft = window.innerWidth - dropdownWidth - 8;
            const left = Math.max(8, Math.min(rect.left, maxLeft));
            setDropdownStyle({
                position: 'fixed',
                ...(openUpward ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
                left,
                width: dropdownWidth,
                zIndex: 99999,
            });
        }
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as Node;
            const isInsideContainer = containerRef.current?.contains(target);
            const isInsideDropdown = (target as HTMLElement).closest?.('[data-namespace-dropdown]');
            if (!isInsideContainer && !isInsideDropdown) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    useEffect(() => {
        if (focusedIndex !== null && itemRefs.current[focusedIndex]) {
            itemRefs.current[focusedIndex]?.scrollIntoView({ block: 'nearest' });
        }
    }, [focusedIndex]);

    const filtered = useMemo(() => {
        const term = search.trim().toLowerCase();
        if (!term) return options;
        return options.filter((o) => o.toLowerCase().includes(term));
    }, [options, search]);

    useEffect(() => {
        if (!isOpen) return;
        if (!search) {
            const idx = filtered.indexOf(value);
            setFocusedIndex(idx >= 0 ? idx : 0);
        } else {
            setFocusedIndex(0);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [search, isOpen]);

    const commit = (next: string) => {
        onChange(next);
        setSearch('');
        setIsOpen(false);
        setFocusedIndex(null);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (!isOpen) {
            if (e.key === 'ArrowDown' || e.key === 'Enter') {
                setIsOpen(true);
                e.preventDefault();
            } else if (e.key === 'Tab' && onArrowNav) {
                e.preventDefault();
                onArrowNav(e.shiftKey ? 'prev' : 'next');
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                if (onArrowNav) {
                    e.preventDefault();
                    onArrowNav(e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowLeft' ? 'left' : 'right');
                }
            }
            return;
        }
        switch (e.key) {
            case 'ArrowDown':
                setFocusedIndex((prev) =>
                    prev === null ? 0 : Math.min(prev + 1, filtered.length - 1)
                );
                e.preventDefault();
                break;
            case 'ArrowUp':
                setFocusedIndex((prev) =>
                    prev === null ? filtered.length - 1 : Math.max(prev - 1, 0)
                );
                e.preventDefault();
                break;
            case 'Enter':
                if (focusedIndex !== null && filtered[focusedIndex]) {
                    commit(filtered[focusedIndex]);
                } else if (search.trim()) {
                    commit(search.trim().toUpperCase());
                }
                e.preventDefault();
                break;
            case 'Tab':
                if (focusedIndex !== null && filtered[focusedIndex]) {
                    commit(filtered[focusedIndex]);
                }
                if (onArrowNav) {
                    e.preventDefault();
                    requestAnimationFrame(() => onArrowNav(e.shiftKey ? 'prev' : 'next'));
                }
                break;
            case 'Escape':
                setIsOpen(false);
                setSearch('');
                e.preventDefault();
                break;
            case 'ArrowLeft':
                if (onArrowNav) {
                    setIsOpen(false);
                    onArrowNav('left');
                    e.preventDefault();
                }
                break;
            case 'ArrowRight':
                if (onArrowNav) {
                    setIsOpen(false);
                    onArrowNav('right');
                    e.preventDefault();
                }
                break;
        }
    };

    const triggerClasses = borderless
        ? `flex items-center cursor-text rounded ${compact ? 'px-2 py-1' : 'px-3 py-2'} ${
              isOpen
                  ? 'bg-input-bg border border-primary/50 ring-1 ring-primary/20'
                  : 'border border-transparent hover:bg-surface-hover/40 focus-within:bg-primary/10 focus-within:ring-1 focus-within:ring-primary/40'
          }`
        : `flex items-center bg-input-bg border rounded-lg ${compact ? 'px-2 py-1' : 'px-3 py-2'} cursor-pointer ${
              isOpen ? 'border-primary/50 ring-1 ring-primary/20' : 'border-border hover:border-border-hover'
          }`;

    return (
        <div ref={containerRef} className={`relative ${className}`}>
            <div
                className={triggerClasses}
                onClick={() => {
                    if (!isOpen) setIsOpen(true);
                    inputRef.current?.focus();
                }}
            >
                <input
                    ref={inputRef}
                    data-cell={cellId}
                    type="text"
                    value={isOpen ? search : value}
                    onChange={(e) => {
                        setSearch(e.target.value);
                        if (!isOpen) setIsOpen(true);
                    }}
                    onFocus={() => {
                        setSearch('');
                        setIsOpen(true);
                        requestAnimationFrame(() => inputRef.current?.select());
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    className={`flex-1 bg-transparent ${compact ? 'text-xs' : 'text-sm'} text-foreground placeholder-foreground-muted focus:outline-none`}
                />
                <svg
                    className={`${compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} text-foreground-muted transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </div>

            {isOpen && typeof document !== 'undefined' &&
                createPortal(
                    <div
                        data-namespace-dropdown
                        style={dropdownStyle}
                        className="bg-background-secondary border border-border rounded-lg shadow-xl max-h-60 overflow-y-auto"
                    >
                        {filtered.length === 0 ? (
                            <div
                                className="px-3 py-2 text-sm cursor-pointer text-foreground hover:bg-surface-hover/50"
                                onClick={() => search.trim() && commit(search.trim().toUpperCase())}
                            >
                                {search.trim() ? (
                                    <span>
                                        Use <span className="font-mono">{search.trim().toUpperCase()}</span>
                                    </span>
                                ) : (
                                    <span className="text-foreground-muted">No options</span>
                                )}
                            </div>
                        ) : (
                            filtered.map((opt, idx) => (
                                <div
                                    key={opt}
                                    ref={(el) => {
                                        itemRefs.current[idx] = el;
                                    }}
                                    onClick={() => commit(opt)}
                                    className={`px-3 py-2 cursor-pointer text-sm text-foreground hover:bg-surface-hover/50 ${
                                        idx === focusedIndex
                                            ? 'bg-primary/20'
                                            : opt === value
                                                ? 'bg-primary/10'
                                                : ''
                                    }`}
                                >
                                    {opt}
                                </div>
                            ))
                        )}
                    </div>,
                    document.body
                )}
        </div>
    );
}
