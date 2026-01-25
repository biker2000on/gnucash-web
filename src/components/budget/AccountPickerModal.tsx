'use client';

import { useState, useEffect } from 'react';
import { Modal } from '@/components/ui/Modal';

interface Account {
    guid: string;
    name: string;
    account_type: string;
    full_name?: string;
}

interface AccountPickerModalProps {
    isOpen: boolean;
    onClose: () => void;
    budgetGuid: string;
    existingAccountGuids: string[];
    onAccountAdded: (account: Account) => void;
}

const BUDGETABLE_TYPES = ['INCOME', 'EXPENSE', 'ASSET', 'LIABILITY', 'BANK', 'CASH', 'CREDIT'];

export function AccountPickerModal({
    isOpen,
    onClose,
    budgetGuid,
    existingAccountGuids,
    onAccountAdded
}: AccountPickerModalProps) {
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [filteredAccounts, setFilteredAccounts] = useState<Account[]>([]);
    const [searchTerm, setSearchTerm] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isAdding, setIsAdding] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (isOpen) {
            fetchAccounts();
        }
    }, [isOpen]);

    useEffect(() => {
        const filtered = accounts.filter(account => {
            const matchesSearch = account.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                (account.full_name?.toLowerCase().includes(searchTerm.toLowerCase()));
            const notAlreadyAdded = !existingAccountGuids.includes(account.guid);
            const isBudgetable = BUDGETABLE_TYPES.includes(account.account_type);
            return matchesSearch && notAlreadyAdded && isBudgetable;
        });
        setFilteredAccounts(filtered);
    }, [accounts, searchTerm, existingAccountGuids]);

    const fetchAccounts = async () => {
        setIsLoading(true);
        setError(null);
        try {
            const response = await fetch('/api/accounts?flat=true');
            if (!response.ok) throw new Error('Failed to fetch accounts');
            const data = await response.json();
            setAccounts(data.accounts || data);
        } catch (err) {
            setError('Failed to load accounts');
        } finally {
            setIsLoading(false);
        }
    };

    const handleAddAccount = async (account: Account) => {
        setIsAdding(true);
        setError(null);
        try {
            const response = await fetch(`/api/budgets/${budgetGuid}/accounts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ account_guid: account.guid })
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Failed to add account');
            }

            onAccountAdded(account);
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to add account');
        } finally {
            setIsAdding(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Add Account to Budget">
            <div className="space-y-4">
                <div>
                    <input
                        type="text"
                        placeholder="Search accounts..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-md text-neutral-100 placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                        autoFocus
                    />
                </div>

                {error && (
                    <div className="p-3 bg-rose-900/30 text-rose-400 border border-rose-800/50 rounded-md text-sm">
                        {error}
                    </div>
                )}

                <div className="max-h-80 overflow-y-auto border border-neutral-700 rounded-md">
                    {isLoading ? (
                        <div className="p-4 text-center text-neutral-400">Loading accounts...</div>
                    ) : filteredAccounts.length === 0 ? (
                        <div className="p-4 text-center text-neutral-400">
                            {searchTerm ? 'No matching accounts found' : 'All accounts are already in the budget'}
                        </div>
                    ) : (
                        <ul className="divide-y divide-neutral-700">
                            {filteredAccounts.map((account) => (
                                <li key={account.guid}>
                                    <button
                                        onClick={() => handleAddAccount(account)}
                                        disabled={isAdding}
                                        className="w-full px-4 py-3 text-left hover:bg-neutral-700/50 transition-colors disabled:opacity-50"
                                    >
                                        <div className="font-medium text-neutral-100">{account.name}</div>
                                        <div className="text-sm text-neutral-400">
                                            {account.full_name && account.full_name !== account.name && (
                                                <span className="mr-2">{account.full_name}</span>
                                            )}
                                            <span className="inline-block px-2 py-0.5 bg-neutral-700 rounded text-xs text-neutral-300">
                                                {account.account_type}
                                            </span>
                                        </div>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <div className="flex justify-end">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-neutral-300 hover:bg-neutral-700 rounded-md transition-colors"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </Modal>
    );
}
