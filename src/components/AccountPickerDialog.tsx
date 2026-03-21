'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Modal } from '@/components/ui/Modal';

/** Strip the root/book account name (first colon-delimited segment) from fullname */
function stripRoot(fullname: string): string {
    const idx = fullname.indexOf(':');
    return idx >= 0 ? fullname.slice(idx + 1) : fullname;
}

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
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isOpen) return;
        setLoading(true);
        setSearch('');
        setSelectedIndex(0);
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
                a => {
                    const display = stripRoot(a.fullname || a.name);
                    return display.toLowerCase().includes(q);
                }
            );
        }
        return result;
    }, [accounts, excludeAccountGuid, commodityGuid, search]);

    // Reset selected index when filter changes
    useEffect(() => {
        setSelectedIndex(0);
    }, [search]);

    // Scroll selected item into view
    useEffect(() => {
        if (!listRef.current) return;
        const items = listRef.current.querySelectorAll('[data-item]');
        items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex]);

    const handleSelect = useCallback((account: FlatAccount) => {
        onSelect(account.guid, account.fullname || account.name);
        onClose();
    }, [onSelect, onClose]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setSelectedIndex(i => Math.min(i + 1, filtered.length - 1));
                break;
            case 'ArrowUp':
                e.preventDefault();
                setSelectedIndex(i => Math.max(i - 1, 0));
                break;
            case 'Enter':
                e.preventDefault();
                if (filtered[selectedIndex]) {
                    handleSelect(filtered[selectedIndex]);
                }
                break;
        }
    }, [filtered, selectedIndex, handleSelect]);

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={title} size="md">
            <div className="p-4 space-y-3" onKeyDown={handleKeyDown}>
                <input
                    ref={inputRef}
                    type="text"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search accounts..."
                    className="w-full px-3 py-2 bg-background-tertiary border border-border rounded-md text-sm text-foreground focus:border-accent focus:outline-none"
                    autoFocus
                />

                <div ref={listRef} className="max-h-72 overflow-y-auto border border-border rounded-md">
                    {loading ? (
                        <div className="p-4 text-center text-foreground-muted text-sm">Loading...</div>
                    ) : filtered.length === 0 ? (
                        <div className="p-4 text-center text-foreground-muted text-sm">No matching accounts</div>
                    ) : (
                        filtered.map((account, index) => (
                            <button
                                key={account.guid}
                                type="button"
                                data-item
                                onClick={() => handleSelect(account)}
                                className={`w-full px-3 py-2 text-sm text-left transition-colors border-b border-border last:border-0 ${
                                    index === selectedIndex
                                        ? 'bg-accent-primary/15 text-foreground'
                                        : 'text-foreground-secondary hover:bg-surface-hover'
                                }`}
                            >
                                {stripRoot(account.fullname || account.name)}
                            </button>
                        ))
                    )}
                </div>

                {/* Footer hint */}
                <div className="flex items-center gap-4 text-xs text-foreground-tertiary">
                    <span className="flex items-center gap-1">
                        <kbd className="px-1 py-0.5 rounded border border-border bg-surface-hover">&uarr;</kbd>
                        <kbd className="px-1 py-0.5 rounded border border-border bg-surface-hover">&darr;</kbd>
                        navigate
                    </span>
                    <span className="flex items-center gap-1">
                        <kbd className="px-1 py-0.5 rounded border border-border bg-surface-hover">&crarr;</kbd>
                        select
                    </span>
                    <span className="flex items-center gap-1">
                        <kbd className="px-1 py-0.5 rounded border border-border bg-surface-hover">esc</kbd>
                        close
                    </span>
                </div>
            </div>
        </Modal>
    );
}
