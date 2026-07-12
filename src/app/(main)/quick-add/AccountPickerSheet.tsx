'use client';

/**
 * Bottom-sheet account picker for the quick-add screen.
 * Mobile-first: full-width slide-up panel with a search box and
 * large (48px) touch targets per account row.
 */

import { useMemo, useState } from 'react';

export interface PickerAccount {
    guid: string;
    name: string;
    fullname?: string;
    account_type: string;
}

interface AccountPickerSheetProps {
    open: boolean;
    title: string;
    accounts: PickerAccount[];
    selectedGuid?: string;
    onSelect: (account: PickerAccount) => void;
    onClose: () => void;
}

export function AccountPickerSheet({
    open,
    title,
    accounts,
    selectedGuid,
    onSelect,
    onClose,
}: AccountPickerSheetProps) {
    const [search, setSearch] = useState('');

    // Clear the search whenever the sheet is dismissed so it opens fresh.
    const handleClose = () => {
        setSearch('');
        onClose();
    };
    const handleSelect = (account: PickerAccount) => {
        setSearch('');
        onSelect(account);
    };

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return accounts;
        return accounts.filter(
            a =>
                a.name.toLowerCase().includes(q) ||
                (a.fullname ?? '').toLowerCase().includes(q)
        );
    }, [accounts, search]);

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={title}>
            {/* Overlay */}
            <button
                type="button"
                aria-label="Close account picker"
                onClick={handleClose}
                className="absolute inset-0 bg-black/50"
            />

            {/* Sheet */}
            <div className="relative bg-surface-elevated border-t border-border rounded-t-lg max-h-[75vh] flex flex-col">
                <div className="flex items-center justify-between px-4 pt-4 pb-2">
                    <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider">{title}</h2>
                    <button
                        type="button"
                        onClick={handleClose}
                        className="h-11 w-11 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                        aria-label="Close"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                <div className="px-4 pb-2">
                    <input
                        type="text"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search accounts..."
                        className="w-full h-12 bg-input-bg border border-border rounded-lg px-3 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50"
                    />
                </div>

                <div className="overflow-y-auto px-2 pb-4">
                    {filtered.length === 0 ? (
                        <p className="text-sm text-foreground-muted text-center py-6">No matching accounts</p>
                    ) : (
                        filtered.map(account => (
                            <button
                                key={account.guid}
                                type="button"
                                onClick={() => handleSelect(account)}
                                className={`w-full min-h-[48px] flex flex-col items-start justify-center px-3 py-2 rounded-lg text-left transition-colors ${
                                    account.guid === selectedGuid
                                        ? 'bg-primary-light text-primary'
                                        : 'text-foreground hover:bg-surface-hover'
                                }`}
                            >
                                <span className="text-sm font-medium">{account.name}</span>
                                {account.fullname && account.fullname !== account.name && (
                                    <span className="text-xs text-foreground-muted truncate w-full">
                                        {account.fullname}
                                    </span>
                                )}
                            </button>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
