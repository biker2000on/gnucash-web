"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

export interface TransactionContextMenuItem {
    id: string;
    label: string;
    onSelect: () => void;
    variant?: 'default' | 'danger';
}

interface TransactionContextMenuProps {
    isOpen: boolean;
    x: number;
    y: number;
    items: TransactionContextMenuItem[];
    onClose: () => void;
}

export function TransactionContextMenu({
    isOpen,
    x,
    y,
    items,
    onClose,
}: TransactionContextMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null);
    const [activeIndex, setActiveIndex] = useState(0);
    const mounted = useSyncExternalStore(
        () => () => undefined,
        () => true,
        () => false
    );

    useEffect(() => {
        if (!isOpen) return;

        const handlePointerDown = (event: PointerEvent) => {
            if (!menuRef.current?.contains(event.target as Node)) {
                onClose();
            }
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
                return;
            }

            if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex(index => Math.min(index + 1, items.length - 1));
                return;
            }

            if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex(index => Math.max(index - 1, 0));
                return;
            }

            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                items[Math.min(activeIndex, items.length - 1)]?.onSelect();
                onClose();
            }
        };

        document.addEventListener('pointerdown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);

        return () => {
            document.removeEventListener('pointerdown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [activeIndex, isOpen, items, onClose]);

    const position = useMemo(() => {
        if (!mounted) return { left: x, top: y };

        const width = 192;
        const height = Math.max(44, items.length * 40 + 8);
        return {
            left: Math.min(x, window.innerWidth - width - 8),
            top: Math.min(y, window.innerHeight - height - 8),
        };
    }, [items.length, mounted, x, y]);

    if (!mounted || !isOpen || items.length === 0) return null;

    return createPortal(
        <div
            ref={menuRef}
            role="menu"
            aria-label="Transaction actions"
            className="fixed z-[10000] w-48 rounded-lg border border-border bg-surface-elevated p-1 shadow-2xl"
            style={position}
        >
            {items.map((item, index) => (
                <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => {
                        item.onSelect();
                        onClose();
                    }}
                    className={`flex min-h-9 w-full items-center rounded-md px-3 py-2 text-left text-sm transition-colors ${
                        item.variant === 'danger'
                            ? 'text-rose-300 hover:bg-rose-500/10 hover:text-rose-200'
                            : 'text-foreground-secondary hover:bg-surface-hover hover:text-foreground'
                    } ${activeIndex === index ? item.variant === 'danger' ? 'bg-rose-500/10 text-rose-200' : 'bg-surface-hover text-foreground' : ''}`}
                >
                    {item.label}
                </button>
            ))}
        </div>,
        document.body
    );
}
