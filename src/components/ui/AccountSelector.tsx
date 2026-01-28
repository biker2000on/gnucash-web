'use client';

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Account } from '@/lib/types';
import { useAccounts } from '@/lib/hooks/useAccounts';

interface AccountSelectorProps {
    value: string;
    onChange: (accountGuid: string, accountName: string) => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
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
}: AccountSelectorProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [selectedName, setSelectedName] = useState('');
    const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

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

    // Filter accounts by search
    const filteredAccounts = accounts.filter(account => {
        // Exclude ROOT account type
        if (account.account_type === 'ROOT') return false;

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

    const handleSelect = (account: Account) => {
        const displayName = formatAccountPath(account.fullname, account.name);
        onChange(account.guid, displayName);
        setSelectedName(displayName);
        setSearch('');
        setIsOpen(false);
    };

    const handleInputFocus = () => {
        setIsOpen(true);
        setSearch('');
    };

    return (
        <div ref={containerRef} className={`relative ${className}`}>
            <div
                className={`flex items-center bg-neutral-950/50 border border-neutral-800 rounded-lg px-3 py-2 cursor-pointer ${
                    disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-neutral-700'
                } ${isOpen ? 'border-cyan-500/50 ring-1 ring-cyan-500/20' : ''}`}
                onClick={() => !disabled && inputRef.current?.focus()}
            >
                <input
                    ref={inputRef}
                    type="text"
                    value={isOpen ? search : selectedName}
                    onChange={(e) => setSearch(e.target.value)}
                    onFocus={handleInputFocus}
                    placeholder={placeholder}
                    disabled={disabled}
                    className="flex-1 bg-transparent text-sm text-neutral-200 placeholder-neutral-500 focus:outline-none"
                />
                <svg
                    className={`w-4 h-4 text-neutral-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}
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
                    className="bg-neutral-900 border border-neutral-800 rounded-lg shadow-xl max-h-64 overflow-y-auto"
                >
                    {loading ? (
                        <div className="px-3 py-4 text-center text-neutral-500 text-sm">
                            Loading accounts...
                        </div>
                    ) : filteredAccounts.length === 0 ? (
                        <div className="px-3 py-4 text-center text-neutral-500 text-sm">
                            No accounts found
                        </div>
                    ) : (
                        Object.entries(groupedAccounts).map(([type, typeAccounts]) => (
                            <div key={type}>
                                <div className="px-3 py-2 text-xs font-semibold text-neutral-500 uppercase tracking-wider bg-neutral-950/50 sticky top-0">
                                    {type}
                                </div>
                                {typeAccounts.map(account => (
                                    <div
                                        key={account.guid}
                                        className={`px-3 py-2 cursor-pointer hover:bg-neutral-800/50 ${
                                            account.guid === value ? 'bg-cyan-500/10 text-cyan-400' : 'text-neutral-200'
                                        }`}
                                        onClick={() => handleSelect(account)}
                                    >
                                        <div className="text-sm">{formatAccountPath(account.fullname, account.name)}</div>
                                    </div>
                                ))}
                            </div>
                        ))
                    )}
                </div>,
                document.body
            )}
        </div>
    );
}
