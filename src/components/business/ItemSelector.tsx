'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { ItemDTO } from '@/components/business/inventory-ui';

interface ItemSelectorProps {
    /** Selected inventory item id (null for none). */
    value: number | null;
    onChange: (itemId: number, item: ItemDTO) => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    hasError?: boolean;
    autoFocus?: boolean;
    compact?: boolean;
    /** Item ids to hide from the dropdown (e.g. a BOM's own output item). */
    excludeItemIds?: number[];
    /**
     * Pre-fetched items to search over. When omitted the selector fetches
     * active items from /api/inventory/items itself.
     */
    items?: ItemDTO[];
}

/**
 * Searchable inventory item picker with the same portal-dropdown behavior as
 * OwnerSelector/AccountSelector (keyboard navigation, click-outside close,
 * flip-up positioning near the bottom of the viewport). Searches SKU + name.
 */
export function ItemSelector({
    value,
    onChange,
    placeholder = 'Select item...',
    disabled = false,
    className = '',
    hasError = false,
    autoFocus,
    compact = false,
    excludeItemIds,
    items: itemsProp,
}: ItemSelectorProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [fetchedItems, setFetchedItems] = useState<ItemDTO[]>([]);
    const [loading, setLoading] = useState(itemsProp === undefined);
    const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

    useEffect(() => {
        if (itemsProp !== undefined) return;
        let cancelled = false;
        setLoading(true);
        fetch('/api/inventory/items')
            .then((res) => (res.ok ? res.json() : { items: [] }))
            .then((data: { items: ItemDTO[] }) => {
                if (!cancelled) setFetchedItems(Array.isArray(data.items) ? data.items : []);
            })
            .catch(() => {})
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [itemsProp]);

    const items = itemsProp ?? fetchedItems;

    useEffect(() => {
        if (autoFocus && inputRef.current) {
            inputRef.current.focus();
            requestAnimationFrame(() => inputRef.current?.select());
        }
    }, [autoFocus]);

    const selectable = useMemo(() => {
        const excluded = new Set(excludeItemIds ?? []);
        return items.filter((i) => i.active && !excluded.has(i.id));
    }, [items, excludeItemIds]);

    const selected = useMemo(
        () => (value == null ? null : items.find((i) => i.id === value) ?? null),
        [items, value],
    );
    const selectedName = selected ? `${selected.sku} — ${selected.name}` : '';

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
            const isInsideDropdown = (target as HTMLElement).closest?.('[data-item-dropdown]');
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
        if (!q) return selectable;
        return selectable.filter(
            (i) => i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q),
        );
    }, [selectable, search]);

    // Focus the current selection when opening, top result while searching.
    useEffect(() => {
        if (isOpen) {
            if (!search && value != null) {
                const idx = filtered.findIndex((i) => i.id === value);
                setFocusedIndex(idx >= 0 ? idx : 0);
            } else {
                setFocusedIndex(0);
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [search, isOpen]);

    const handleSelect = (item: ItemDTO) => {
        onChange(item.id, item);
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
                    placeholder={placeholder}
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
                    data-item-dropdown
                    style={dropdownStyle}
                    className="bg-background-secondary border border-border rounded-lg shadow-xl max-h-64 overflow-y-auto"
                >
                    {loading ? (
                        <div className="px-3 py-4 text-center text-foreground-muted text-sm">
                            Loading items...
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="px-3 py-4 text-center text-foreground-muted text-sm">
                            No items found
                        </div>
                    ) : (
                        filtered.map((item, index) => (
                            <div
                                key={item.id}
                                ref={(el) => { itemRefs.current[index] = el; }}
                                className={`px-3 py-2 cursor-pointer text-foreground hover:bg-surface-hover/50 flex items-baseline justify-between gap-3 ${
                                    index === focusedIndex
                                        ? 'bg-primary/20'
                                        : item.id === value
                                            ? 'bg-primary/10'
                                            : ''
                                }`}
                                onClick={() => handleSelect(item)}
                            >
                                <span className="text-sm truncate">{item.name}</span>
                                <span className="text-xs font-mono tabular-nums text-foreground-muted shrink-0">{item.sku}</span>
                            </div>
                        ))
                    )}
                </div>,
                document.body,
            )}
        </div>
    );
}
