'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { ContactKind, CustomerDTO, VendorDTO } from '@/lib/business-types';

export type OwnerDTO = CustomerDTO | VendorDTO;

interface OwnerSelectorProps {
    /** 'customer' for invoices, 'vendor' for bills. */
    kind: ContactKind;
    /** Selected owner guid ('' for none). */
    value: string;
    onChange: (ownerGuid: string, owner: OwnerDTO) => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    hasError?: boolean;
    autoFocus?: boolean;
    compact?: boolean;
}

/**
 * Searchable customer/vendor picker with the same portal-dropdown behavior
 * as AccountSelector (keyboard navigation, click-outside close, flip-up
 * positioning near the bottom of the viewport).
 */
export function OwnerSelector({
    kind,
    value,
    onChange,
    placeholder,
    disabled = false,
    className = '',
    hasError = false,
    autoFocus,
    compact = false,
}: OwnerSelectorProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [owners, setOwners] = useState<OwnerDTO[]>([]);
    const [loading, setLoading] = useState(true);
    const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

    const effectivePlaceholder = placeholder ?? (kind === 'customer' ? 'Select customer...' : 'Select vendor...');

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        fetch(`/api/business/${kind}s?active=active`)
            .then((res) => (res.ok ? res.json() : []))
            .then((rows: OwnerDTO[]) => {
                if (!cancelled) setOwners(Array.isArray(rows) ? rows : []);
            })
            .catch(() => {})
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [kind]);

    useEffect(() => {
        if (autoFocus && inputRef.current) {
            inputRef.current.focus();
            requestAnimationFrame(() => inputRef.current?.select());
        }
    }, [autoFocus]);

    const selected = useMemo(() => owners.find((o) => o.guid === value) ?? null, [owners, value]);
    const selectedName = selected ? selected.name : '';

    // Position the dropdown when opening — flip upward near the bottom edge.
    useEffect(() => {
        if (isOpen && containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            const maxDropdownHeight = 256;
            const spaceBelow = window.innerHeight - rect.bottom;
            const spaceAbove = rect.top;
            const openUpward = spaceBelow < maxDropdownHeight && spaceAbove > spaceBelow;

            const minWidth = 320;
            const dropdownWidth = Math.max(rect.width, minWidth);
            const maxLeft = window.innerWidth - dropdownWidth - 8;
            const left = Math.max(8, Math.min(rect.left, maxLeft));

            setDropdownStyle({
                position: 'fixed',
                ...(openUpward
                    ? { bottom: window.innerHeight - rect.top + 4 }
                    : { top: rect.bottom + 4 }),
                left,
                width: dropdownWidth,
                zIndex: 99999,
            });
        }
    }, [isOpen]);

    // Close on outside click (dropdown lives in a portal).
    useEffect(() => {
        if (!isOpen) return;
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as Node;
            const isInsideContainer = containerRef.current?.contains(target);
            const isInsideDropdown = (target as HTMLElement).closest?.('[data-owner-dropdown]');
            if (!isInsideContainer && !isInsideDropdown) setIsOpen(false);
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    useEffect(() => {
        if (focusedIndex !== null && itemRefs.current[focusedIndex]) {
            itemRefs.current[focusedIndex]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }, [focusedIndex]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return owners;
        return owners.filter(
            (o) =>
                o.name.toLowerCase().includes(q) ||
                o.id.toLowerCase().includes(q) ||
                (o.address.email ?? '').toLowerCase().includes(q),
        );
    }, [owners, search]);

    // Focus the current selection when opening, top result while searching.
    useEffect(() => {
        if (isOpen) {
            if (!search && value) {
                const idx = filtered.findIndex((o) => o.guid === value);
                setFocusedIndex(idx >= 0 ? idx : 0);
            } else {
                setFocusedIndex(0);
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [search, isOpen]);

    const handleSelect = (owner: OwnerDTO) => {
        onChange(owner.guid, owner);
        setSearch('');
        setIsOpen(false);
        setFocusedIndex(null);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (!isOpen) {
            if (e.key === 'ArrowDown' || e.key === 'Enter') {
                setIsOpen(true);
                e.preventDefault();
            }
            return;
        }
        switch (e.key) {
            case 'ArrowDown':
                setFocusedIndex((prev) => (prev === null ? 0 : Math.min(prev + 1, filtered.length - 1)));
                e.preventDefault();
                break;
            case 'ArrowUp':
                setFocusedIndex((prev) => (prev === null ? filtered.length - 1 : Math.max(prev - 1, 0)));
                e.preventDefault();
                break;
            case 'Enter':
                if (focusedIndex !== null && filtered[focusedIndex]) {
                    handleSelect(filtered[focusedIndex]);
                    e.preventDefault();
                }
                break;
            case 'Tab':
                if (focusedIndex !== null && filtered[focusedIndex]) {
                    handleSelect(filtered[focusedIndex]);
                }
                break;
            case 'Escape':
                setIsOpen(false);
                setFocusedIndex(null);
                e.preventDefault();
                e.stopPropagation();
                break;
        }
    };

    return (
        <div ref={containerRef} className={`relative ${className}`}>
            <div
                className={`flex items-center bg-input-bg border rounded-lg ${compact ? 'px-2 py-1' : 'px-3 py-2'} cursor-pointer ${
                    disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-border-hover'
                } ${isOpen ? 'border-primary/50 ring-1 ring-primary/20' : hasError ? 'border-rose-500 ring-1 ring-rose-500/30' : 'border-border'}`}
                onClick={() => !disabled && inputRef.current?.focus()}
            >
                <input
                    ref={inputRef}
                    type="text"
                    value={isOpen ? search : selectedName}
                    onChange={(e) => {
                        setSearch(e.target.value);
                        if (!isOpen) setIsOpen(true);
                    }}
                    onFocus={() => {
                        setSearch('');
                        requestAnimationFrame(() => inputRef.current?.select());
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder={effectivePlaceholder}
                    disabled={disabled}
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

            {isOpen && typeof document !== 'undefined' && createPortal(
                <div
                    data-owner-dropdown
                    style={dropdownStyle}
                    className="bg-background-secondary border border-border rounded-lg shadow-xl max-h-64 overflow-y-auto"
                >
                    {loading ? (
                        <div className="px-3 py-4 text-center text-foreground-muted text-sm">
                            Loading {kind === 'customer' ? 'customers' : 'vendors'}...
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="px-3 py-4 text-center text-foreground-muted text-sm">
                            No {kind === 'customer' ? 'customers' : 'vendors'} found
                        </div>
                    ) : (
                        filtered.map((owner, index) => (
                            <div
                                key={owner.guid}
                                ref={(el) => { itemRefs.current[index] = el; }}
                                className={`px-3 py-2 cursor-pointer text-foreground hover:bg-surface-hover/50 flex items-baseline justify-between gap-3 ${
                                    index === focusedIndex
                                        ? 'bg-primary/20'
                                        : owner.guid === value
                                            ? 'bg-primary/10'
                                            : ''
                                }`}
                                onClick={() => handleSelect(owner)}
                            >
                                <span className="text-sm truncate">{owner.name}</span>
                                <span className="text-xs font-mono tabular-nums text-foreground-muted shrink-0">{owner.id}</span>
                            </div>
                        ))
                    )}
                </div>,
                document.body,
            )}
        </div>
    );
}
