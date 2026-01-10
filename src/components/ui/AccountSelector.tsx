'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Account } from '@/lib/types';

interface AccountSelectorProps {
    value: string;
    onChange: (accountGuid: string, accountName: string) => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
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
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [loading, setLoading] = useState(false);
    const [selectedName, setSelectedName] = useState('');
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // Fetch accounts with fullname
    const fetchAccounts = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/accounts?flat=true');
            if (!res.ok) throw new Error('Failed to fetch accounts');
            const data = await res.json();
            setAccounts(data);

            // If we have a value, find and set the selected name
            if (value) {
                const selected = data.find((a: Account) => a.guid === value);
                if (selected) {
                    setSelectedName(selected.fullname || selected.name);
                }
            }
        } catch (error) {
            console.error('Error fetching accounts:', error);
        } finally {
            setLoading(false);
        }
    }, [value]);

    useEffect(() => {
        fetchAccounts();
    }, [fetchAccounts]);

    // Update selected name when value changes
    useEffect(() => {
        if (value && accounts.length > 0) {
            const selected = accounts.find(a => a.guid === value);
            if (selected) {
                setSelectedName(selected.fullname || selected.name);
            }
        } else if (!value) {
            setSelectedName('');
        }
    }, [value, accounts]);

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Filter accounts by search
    const filteredAccounts = accounts.filter(account => {
        const searchLower = search.toLowerCase();
        const fullname = account.fullname || account.name;
        return fullname.toLowerCase().includes(searchLower) ||
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
        onChange(account.guid, account.fullname || account.name);
        setSelectedName(account.fullname || account.name);
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

            {isOpen && (
                <div className="absolute z-50 w-full mt-1 bg-neutral-900 border border-neutral-800 rounded-lg shadow-xl max-h-64 overflow-y-auto">
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
                                        <div className="text-sm">{account.fullname || account.name}</div>
                                    </div>
                                ))}
                            </div>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
