'use client';

import { useState, useEffect, useMemo } from 'react';
import { Modal } from '@/components/ui/Modal';

interface FlatAccount {
    guid: string;
    name: string;
    fullname: string;
    account_type: string;
    commodity_guid: string | null;
    commodity_mnemonic: string;
}

interface AccountPickerDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (accountGuid: string, accountName: string) => void;
    excludeAccountGuid?: string;
    commodityGuid?: string;
    title?: string;
}

export default function AccountPickerDialog({
    isOpen,
    onClose,
    onSelect,
    excludeAccountGuid,
    commodityGuid,
    title = 'Select Account',
}: AccountPickerDialogProps) {
    const [accounts, setAccounts] = useState<FlatAccount[]>([]);
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!isOpen) return;
        setLoading(true);
        setSearch('');
        fetch('/api/accounts?flat=true')
            .then(res => res.json())
            .then(data => {
                setAccounts(Array.isArray(data) ? data : data.accounts || []);
                setLoading(false);
            })
            .catch(() => setLoading(false));
    }, [isOpen]);

    const filtered = useMemo(() => {
        let result = accounts;
        if (excludeAccountGuid) {
            result = result.filter(a => a.guid !== excludeAccountGuid);
        }
        if (commodityGuid) {
            result = result.filter(a => a.commodity_guid === commodityGuid);
        }
        if (search) {
            const q = search.toLowerCase();
            result = result.filter(
                a =>
                    a.name.toLowerCase().includes(q) ||
                    (a.fullname && a.fullname.toLowerCase().includes(q))
            );
        }
        return result;
    }, [accounts, excludeAccountGuid, commodityGuid, search]);

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={title} size="md">
            <div className="p-4 space-y-3">
                <input
                    type="text"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search accounts..."
                    className="w-full px-3 py-2 bg-background-tertiary border border-border rounded-md text-sm text-foreground focus:border-accent focus:outline-none"
                    autoFocus
                />

                <div className="max-h-72 overflow-y-auto border border-border rounded-md">
                    {loading ? (
                        <div className="p-4 text-center text-foreground-muted text-sm">Loading...</div>
                    ) : filtered.length === 0 ? (
                        <div className="p-4 text-center text-foreground-muted text-sm">No matching accounts</div>
                    ) : (
                        filtered.map(account => (
                            <button
                                key={account.guid}
                                type="button"
                                onClick={() => {
                                    onSelect(account.guid, account.fullname || account.name);
                                    onClose();
                                }}
                                className="w-full px-3 py-2 text-sm text-left text-foreground hover:bg-surface-hover border-b border-border last:border-0 transition-colors"
                            >
                                <div>{account.fullname || account.name}</div>
                                <div className="text-xs text-foreground-muted">{account.account_type}</div>
                            </button>
                        ))
                    )}
                </div>
            </div>
        </Modal>
    );
}
