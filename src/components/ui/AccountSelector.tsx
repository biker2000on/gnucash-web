'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Account } from '@/lib/types';
import { useAccounts } from '@/lib/hooks/useAccounts';

interface AccountSelectorProps {
    value: string;
    onChange: (accountGuid: string, accountName: string) => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    hasError?: boolean;
    accountTypes?: string[];
}

// Strip "Root Account:" prefix from account paths
function formatAccountPath(fullname: string | undefined, name: string): string {
    const path = fullname || name;
    // Remove "Root Account:" prefix if present
    if (path.startsWith('Root Account:')) {
        return path.substring('Root Account:'.length);
    }
    return path;
}

export function AccountSelector({
    value,
    onChange,
    placeholder = 'Select account...',
    disabled = false,
    className = '',
    hasError = false,
    accountTypes,
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

    // Log errors
    useEffect(() => {
        if (error) {
            console.error('Error fetching accounts:', error);
        }
    }, [error]);

    // Update selected name when value changes
    useEffect(() => {
        if (value && accounts.length > 0) {
            const selected = accounts.find(a => a.guid === value);
            if (selected) {
                setSelectedName(formatAccountPath(selected.fullname, selected.name));
            }
        } else if (!value) {
            setSelectedName('');
        }
    }, [value, accounts]);

    // Calculate dropdown position when opening
    useEffect(() => {
        if (isOpen && containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            setDropdownStyle({
                position: 'fixed',
                top: rect.bottom + 4,
                left: rect.left,
                width: rect.width,
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

    // Reset focus index when search changes or dropdown opens
    useEffect(() => {
        if (isOpen) {
            setFocusedIndex(0);
        }
    }, [search, isOpen]);

    // Scroll focused item into view
    useEffect(() => {
        if (focusedIndex !== null && itemRefs.current[focusedIndex]) {
            itemRefs.current[focusedIndex]?.scrollIntoView({
                block: 'nearest',
                behavior: 'smooth'
            });
        }
    }, [focusedIndex]);

    // Filter accounts by search
    const filteredAccounts = accounts.filter(account => {
        // Exclude ROOT account type
        if (account.account_type === 'ROOT') return false;

        // Filter by account types if provided
        if (accountTypes && !accountTypes.includes(account.account_type)) return false;

        const searchLower = search.toLowerCase();
        const displayName = formatAccountPath(account.fullname, account.name);
        return displayName.toLowerCase().includes(searchLower) ||
            account.account_type.toLowerCase().includes(searchLower);
    });

    // Group accounts by type
    const groupedAccounts = filteredAccounts.reduce((acc, account) => {
        const type = account.account_type;
        if (!acc[type]) acc[type] = [];
        acc[type].push(account);
        return acc;
    }, {} as Record<string, Account[]>);

    // Create flattened list of all visible accounts for keyboard navigation
    const flatOptions = useMemo(() => {
        const result: Account[] = [];
        Object.entries(groupedAccounts).forEach(([, accounts]) => {
            result.push(...accounts);
        });
        return result;
    }, [groupedAccounts]);

    const handleSelect = (account: Account) => {
        const displayName = formatAccountPath(account.fullname, account.name);
        onChange(account.guid, displayName);
        setSelectedName(displayName);
        setSearch('');
        setIsOpen(false);
        setFocusedIndex(null);
    };

    const handleInputFocus = () => {
        setIsOpen(true);
        setSearch('');
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (!isOpen) {
            if (e.key === 'ArrowDown') {
                setIsOpen(true);
                setFocusedIndex(0);
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
                    onChange={(e) => setSearch(e.target.value)}
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
                                                className={`px-3 py-2 cursor-pointer hover:bg-surface-hover/50 ${
                                                    currentIndex === focusedIndex ? 'bg-blue-100 dark:bg-blue-900' : ''
                                                } ${
                                                    account.guid === value ? 'bg-cyan-500/10 text-cyan-400' : 'text-foreground'
                                                }`}
                                                onClick={() => handleSelect(account)}
                                            >
                                                <div className="text-sm">{formatAccountPath(account.fullname, account.name)}</div>
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
