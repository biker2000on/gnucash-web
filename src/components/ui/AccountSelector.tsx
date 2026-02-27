'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Account } from '@/lib/types';
import { useAccounts } from '@/lib/hooks/useAccounts';
import { useBooks } from '@/contexts/BookContext';
import { formatAccountPath } from '@/lib/account-utils';

interface AccountSelectorProps {
    value: string;
    onChange: (accountGuid: string, accountName: string) => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    hasError?: boolean;
    onEnter?: () => void;
    onArrowUp?: () => void;
    onArrowDown?: () => void;
    autoFocus?: boolean;
}

export function AccountSelector({
    value,
    onChange,
    placeholder = 'Select account...',
    disabled = false,
    className = '',
    hasError = false,
    onEnter,
    onArrowUp,
    onArrowDown,
    autoFocus,
}: AccountSelectorProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [selectedName, setSelectedName] = useState('');
    const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

    // Use React Query hook for accounts
    const { data: accounts = [], isLoading: loading, error } = useAccounts({ flat: true });

    // Get active book name for stripping from account paths
    const { activeBookGuid, books } = useBooks();
    const bookName = useMemo(() => {
        if (!activeBookGuid) return undefined;
        return books.find(b => b.guid === activeBookGuid)?.name;
    }, [activeBookGuid, books]);

    // Log errors
    useEffect(() => {
        if (error) {
            console.error('Error fetching accounts:', error);
        }
    }, [error]);

    // Auto-focus when requested
    useEffect(() => {
        if (autoFocus) {
            inputRef.current?.focus();
        }
    }, [autoFocus]);

    // Update selected name when value changes
    useEffect(() => {
        if (value && accounts.length > 0) {
            const selected = accounts.find(a => a.guid === value);
            if (selected) {
                setSelectedName(formatAccountPath(selected.fullname, selected.name, bookName));
            }
        } else if (!value) {
            setSelectedName('');
        }
    }, [value, accounts, bookName]);

    // Calculate dropdown position when opening — flip upward if near bottom
    useEffect(() => {
        if (isOpen && containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            const maxDropdownHeight = 256; // max-h-64 = 16rem = 256px
            const spaceBelow = window.innerHeight - rect.bottom;
            const spaceAbove = rect.top;
            const openUpward = spaceBelow < maxDropdownHeight && spaceAbove > spaceBelow;

            const minWidth = 360;
            const dropdownWidth = Math.max(rect.width, minWidth);
            // Clamp left so the dropdown doesn't overflow the right edge of the viewport
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

    // Close dropdown when clicking outside (accounts for portal)
    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as Node;
            // Check if click is inside the container or the dropdown (which is in a portal)
            const isInsideContainer = containerRef.current?.contains(target);
            const isInsideDropdown = (target as HTMLElement).closest?.('[data-account-dropdown]');

            if (!isInsideContainer && !isInsideDropdown) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    // Scroll focused item into view
    useEffect(() => {
        if (focusedIndex !== null && itemRefs.current[focusedIndex]) {
            itemRefs.current[focusedIndex]?.scrollIntoView({
                block: 'nearest',
                behavior: 'smooth'
            });
        }
    }, [focusedIndex]);

    // Filter accounts by search (memoized)
    const filteredAccounts = useMemo(() =>
        accounts.filter(account => {
            if (account.account_type === 'ROOT') return false;
            const searchLower = search.toLowerCase();
            const displayName = formatAccountPath(account.fullname, account.name, bookName);
            return displayName.toLowerCase().includes(searchLower) ||
                account.account_type.toLowerCase().includes(searchLower);
        }),
        [accounts, search, bookName]
    );

    // Group accounts by type (memoized)
    const groupedAccounts = useMemo(() =>
        filteredAccounts.reduce((acc, account) => {
            const type = account.account_type;
            if (!acc[type]) acc[type] = [];
            acc[type].push(account);
            return acc;
        }, {} as Record<string, Account[]>),
        [filteredAccounts]
    );

    // Create flattened list of all visible accounts for keyboard navigation
    const flatOptions = useMemo(() => {
        const result: Account[] = [];
        Object.entries(groupedAccounts).forEach(([, accs]) => {
            result.push(...accs);
        });
        return result;
    }, [groupedAccounts]);

    // Set focus index to current selection when dropdown opens, or reset on search
    // Deps intentionally limited to [search, isOpen] to avoid resetting on flatOptions reference changes
    useEffect(() => {
        if (isOpen) {
            if (!search && value) {
                const idx = flatOptions.findIndex(a => a.guid === value);
                setFocusedIndex(idx >= 0 ? idx : 0);
            } else {
                setFocusedIndex(0);
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [search, isOpen]);

    const handleSelect = (account: Account) => {
        const displayName = formatAccountPath(account.fullname, account.name, bookName);
        onChange(account.guid, displayName);
        setSelectedName(displayName);
        setSearch('');
        setIsOpen(false);
        setFocusedIndex(null);
    };

    // Task 2.2: Don't open dropdown on focus — only clear search and select text
    const handleInputFocus = () => {
        setSearch('');
        inputRef.current?.select();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (!isOpen) {
            if (e.key === 'ArrowDown') {
                setIsOpen(true);
                setFocusedIndex(0);
                e.preventDefault();
            } else if (e.key === 'Enter') {
                onEnter?.();
                e.preventDefault();
            } else if (e.key === 'ArrowUp') {
                onArrowUp?.();
                e.preventDefault();
            }
            return;
        }

        switch (e.key) {
            case 'ArrowDown':
                setFocusedIndex(prev =>
                    prev === null ? 0 : Math.min(prev + 1, flatOptions.length - 1)
                );
                e.preventDefault();
                break;
            case 'ArrowUp':
                setFocusedIndex(prev =>
                    prev === null ? flatOptions.length - 1 : Math.max(prev - 1, 0)
                );
                e.preventDefault();
                break;
            case 'Enter':
                if (focusedIndex !== null && flatOptions[focusedIndex]) {
                    handleSelect(flatOptions[focusedIndex]);
                    e.preventDefault();
                }
                break;
            case 'Tab':
                if (focusedIndex !== null && flatOptions[focusedIndex]) {
                    handleSelect(flatOptions[focusedIndex]);
                }
                break;
            case 'Escape':
                setIsOpen(false);
                setFocusedIndex(null);
                e.preventDefault();
                break;
        }
    };

    return (
        <div ref={containerRef} className={`relative ${className}`}>
            <div
                className={`flex items-center bg-input-bg border rounded-lg px-3 py-2 cursor-pointer ${
                    disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-border-hover'
                } ${isOpen ? 'border-cyan-500/50 ring-1 ring-cyan-500/20' : hasError ? 'border-rose-500 ring-1 ring-rose-500/30' : 'border-border'}`}
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
                    onFocus={handleInputFocus}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    disabled={disabled}
                    className="flex-1 bg-transparent text-sm text-foreground placeholder-foreground-muted focus:outline-none"
                />
                <svg
                    className={`w-4 h-4 text-foreground-muted transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </div>

            {isOpen && typeof document !== 'undefined' && createPortal(
                <div
                    data-account-dropdown
                    style={dropdownStyle}
                    className="bg-background-secondary border border-border rounded-lg shadow-xl max-h-64 overflow-y-auto"
                >
                    {loading ? (
                        <div className="px-3 py-4 text-center text-foreground-muted text-sm">
                            Loading accounts...
                        </div>
                    ) : filteredAccounts.length === 0 ? (
                        <div className="px-3 py-4 text-center text-foreground-muted text-sm">
                            No accounts found
                        </div>
                    ) : (
                        (() => {
                            let globalIndex = 0;
                            return Object.entries(groupedAccounts).map(([type, typeAccounts]) => (
                                <div key={type}>
                                    <div className="px-3 py-2 text-xs font-semibold text-foreground-muted uppercase tracking-wider bg-input-bg sticky top-0">
                                        {type}
                                    </div>
                                    {typeAccounts.map(account => {
                                        const currentIndex = globalIndex++;
                                        return (
                                            <div
                                                key={account.guid}
                                                ref={el => { itemRefs.current[currentIndex] = el; }}
                                                className={`px-3 py-2 cursor-pointer text-foreground hover:bg-surface-hover/50 ${
                                                    currentIndex === focusedIndex
                                                        ? 'bg-cyan-500/20'
                                                        : account.guid === value
                                                            ? 'bg-cyan-500/10'
                                                            : ''
                                                }`}
                                                onClick={() => handleSelect(account)}
                                            >
                                                <div className="text-sm">{formatAccountPath(account.fullname, account.name, bookName)}</div>
                                            </div>
                                        );
                                    })}
                                </div>
                            ));
                        })()
                    )}
                </div>,
                document.body
            )}
        </div>
    );
}
