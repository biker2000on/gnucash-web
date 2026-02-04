'use client';

import { useState, useEffect, useRef } from 'react';
import { useFormKeyboardShortcuts } from '@/lib/hooks/useFormKeyboardShortcuts';

const ACCOUNT_TYPES = [
    { value: 'ASSET', label: 'Asset', group: 'Assets' },
    { value: 'BANK', label: 'Bank Account', group: 'Assets' },
    { value: 'CASH', label: 'Cash', group: 'Assets' },
    { value: 'RECEIVABLE', label: 'Accounts Receivable', group: 'Assets' },
    { value: 'STOCK', label: 'Stock', group: 'Assets' },
    { value: 'MUTUAL', label: 'Mutual Fund', group: 'Assets' },
    { value: 'LIABILITY', label: 'Liability', group: 'Liabilities' },
    { value: 'CREDIT', label: 'Credit Card', group: 'Liabilities' },
    { value: 'PAYABLE', label: 'Accounts Payable', group: 'Liabilities' },
    { value: 'INCOME', label: 'Income', group: 'Income' },
    { value: 'EXPENSE', label: 'Expense', group: 'Expenses' },
    { value: 'EQUITY', label: 'Equity', group: 'Equity' },
    { value: 'TRADING', label: 'Trading', group: 'Other' },
] as const;

interface AccountFormData {
    name: string;
    account_type: string;
    parent_guid: string | null;
    commodity_guid: string;
    code: string;
    description: string;
    hidden: number;
    placeholder: number;
}

interface FlatAccount {
    guid: string;
    name: string;
    fullname: string;
    account_type: string;
    commodity_mnemonic?: string;
}

interface Commodity {
    guid: string;
    mnemonic: string;
    fullname: string | null;
    namespace: string;
}

interface AccountFormProps {
    mode: 'create' | 'edit';
    initialData?: Partial<AccountFormData>;
    parentGuid?: string | null; // Pre-selected parent for "New Child" action
    onSave: (data: AccountFormData) => Promise<void>;
    onCancel: () => void;
}

export function AccountForm({ mode, initialData, parentGuid, onSave, onCancel }: AccountFormProps) {
    const [formData, setFormData] = useState<AccountFormData>({
        name: initialData?.name || '',
        account_type: initialData?.account_type || 'ASSET',
        parent_guid: parentGuid ?? initialData?.parent_guid ?? null,
        commodity_guid: initialData?.commodity_guid || '',
        code: initialData?.code || '',
        description: initialData?.description || '',
        hidden: initialData?.hidden ?? 0,
        placeholder: initialData?.placeholder ?? 0,
    });

    const [accounts, setAccounts] = useState<FlatAccount[]>([]);
    const [commodities, setCommodities] = useState<Commodity[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const formRef = useRef<HTMLFormElement>(null);

    // Fetch accounts and commodities for dropdowns
    useEffect(() => {
        async function fetchData() {
            setLoading(true);
            try {
                const [accountsRes, commoditiesRes] = await Promise.all([
                    fetch('/api/accounts?flat=true'),
                    fetch('/api/commodities'),
                ]);

                if (accountsRes.ok) {
                    const accs = await accountsRes.json();
                    setAccounts(accs);
                }

                if (commoditiesRes.ok) {
                    const allComms = await commoditiesRes.json();
                    // Filter to currencies only for the selector
                    const comms = allComms.filter((c: Commodity) =>
                        c.namespace === 'CURRENCY' || c.namespace === 'ISO4217'
                    );
                    setCommodities(comms);
                    // Set default commodity if not set
                    if (!formData.commodity_guid && comms.length > 0) {
                        const usd = comms.find((c: Commodity) => c.mnemonic === 'USD');
                        setFormData(prev => ({
                            ...prev,
                            commodity_guid: usd?.guid || comms[0].guid,
                        }));
                    }
                }
            } catch (err) {
                console.error('Error fetching form data:', err);
            } finally {
                setLoading(false);
            }
        }

        fetchData();
    }, []);

    // Update commodity when parent changes (inherit from parent)
    useEffect(() => {
        if (mode === 'create' && formData.parent_guid) {
            const parent = accounts.find(a => a.guid === formData.parent_guid);
            if (parent?.commodity_mnemonic) {
                const parentComm = commodities.find(c => c.mnemonic === parent.commodity_mnemonic);
                if (parentComm) {
                    setFormData(prev => ({ ...prev, commodity_guid: parentComm.guid }));
                }
            }
        }
    }, [formData.parent_guid, accounts, commodities, mode]);

    const validateForm = (): { valid: boolean; error: string | null; fieldErrors: Record<string, string> } => {
        const fieldErrors: Record<string, string> = {};

        if (!formData.name?.trim()) {
            fieldErrors.name = 'Required';
        }
        if (mode === 'create' && !formData.commodity_guid) {
            fieldErrors.commodity_guid = 'Required';
        }

        const hasErrors = Object.keys(fieldErrors).length > 0;
        return {
            valid: !hasErrors,
            error: hasErrors ? 'Please fix the validation errors' : null,
            fieldErrors
        };
    };

    const handleSubmit = async (e?: React.FormEvent) => {
        if (e) e.preventDefault();

        const validation = validateForm();
        setFieldErrors(validation.fieldErrors);
        setError(validation.error);

        if (!validation.valid) {
            // Focus first invalid field
            const firstErrorField = Object.keys(validation.fieldErrors)[0];
            if (firstErrorField) {
                const element = document.querySelector(`[data-field="${firstErrorField}"]`) as HTMLElement;
                element?.focus();
            }
            return;
        }

        setSaving(true);

        try {
            await onSave(formData);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save account');
        } finally {
            setSaving(false);
        }
    };

    // Setup keyboard shortcut
    useFormKeyboardShortcuts(formRef, () => handleSubmit(), {
        validate: () => validateForm().valid
    });

    const groupedAccountTypes = ACCOUNT_TYPES.reduce((acc, type) => {
        if (!acc[type.group]) acc[type.group] = [];
        acc[type.group].push(type);
        return acc;
    }, {} as Record<string, typeof ACCOUNT_TYPES[number][]>);

    if (loading) {
        return (
            <div className="flex items-center justify-center p-8">
                <div className="w-5 h-5 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
            </div>
        );
    }

    return (
        <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
                <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-4 text-rose-400 text-sm">
                    {error}
                </div>
            )}

            {/* Name */}
            <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">
                    Account Name <span className="text-rose-400">*</span>
                </label>
                <input
                    type="text"
                    required
                    data-field="name"
                    value={formData.name}
                    onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    className={`w-full bg-neutral-950/50 border rounded-xl px-4 py-3 text-neutral-200 focus:outline-none focus:border-emerald-500/50 transition-all ${
                        fieldErrors.name ? 'border-rose-500 ring-1 ring-rose-500/30' : 'border-neutral-800'
                    }`}
                    placeholder="e.g., Checking Account"
                />
                {fieldErrors.name && (
                    <p className="mt-1 text-xs text-rose-400">{fieldErrors.name}</p>
                )}
            </div>

            {/* Account Type - only for create mode */}
            {mode === 'create' && (
                <div>
                    <label className="block text-sm font-medium text-neutral-300 mb-2">
                        Account Type <span className="text-rose-400">*</span>
                    </label>
                    <select
                        required
                        value={formData.account_type}
                        onChange={e => setFormData(prev => ({ ...prev, account_type: e.target.value }))}
                        className="w-full bg-neutral-950/50 border border-neutral-800 rounded-xl px-4 py-3 text-neutral-200 focus:outline-none focus:border-emerald-500/50 transition-all cursor-pointer"
                    >
                        {Object.entries(groupedAccountTypes).map(([group, types]) => (
                            <optgroup key={group} label={group}>
                                {types.map(type => (
                                    <option key={type.value} value={type.value}>
                                        {type.label}
                                    </option>
                                ))}
                            </optgroup>
                        ))}
                    </select>
                </div>
            )}

            {/* Parent Account - only for create mode */}
            {mode === 'create' && (
                <div>
                    <label className="block text-sm font-medium text-neutral-300 mb-2">
                        Parent Account
                    </label>
                    <select
                        value={formData.parent_guid || ''}
                        onChange={e => setFormData(prev => ({ ...prev, parent_guid: e.target.value || null }))}
                        className="w-full bg-neutral-950/50 border border-neutral-800 rounded-xl px-4 py-3 text-neutral-200 focus:outline-none focus:border-emerald-500/50 transition-all cursor-pointer"
                    >
                        <option value="">(Top Level)</option>
                        {accounts.map(acc => (
                            <option key={acc.guid} value={acc.guid}>
                                {acc.fullname}
                            </option>
                        ))}
                    </select>
                    <p className="mt-1 text-xs text-neutral-500">
                        Select a parent to create a sub-account, or leave empty for top-level.
                    </p>
                </div>
            )}

            {/* Currency/Commodity - only for create mode */}
            {mode === 'create' && (
                <div>
                    <label className="block text-sm font-medium text-neutral-300 mb-2">
                        Currency <span className="text-rose-400">*</span>
                    </label>
                    <select
                        required
                        data-field="commodity_guid"
                        value={formData.commodity_guid}
                        onChange={e => setFormData(prev => ({ ...prev, commodity_guid: e.target.value }))}
                        className={`w-full bg-neutral-950/50 border rounded-xl px-4 py-3 text-neutral-200 focus:outline-none focus:border-emerald-500/50 transition-all cursor-pointer ${
                            fieldErrors.commodity_guid ? 'border-rose-500 ring-1 ring-rose-500/30' : 'border-neutral-800'
                        }`}
                    >
                        {commodities.map(comm => (
                            <option key={comm.guid} value={comm.guid}>
                                {comm.mnemonic} - {comm.fullname || comm.mnemonic}
                            </option>
                        ))}
                    </select>
                    {fieldErrors.commodity_guid && (
                        <p className="mt-1 text-xs text-rose-400">{fieldErrors.commodity_guid}</p>
                    )}
                </div>
            )}

            {/* Account Code */}
            <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">
                    Account Code
                </label>
                <input
                    type="text"
                    value={formData.code}
                    onChange={e => setFormData(prev => ({ ...prev, code: e.target.value }))}
                    className="w-full bg-neutral-950/50 border border-neutral-800 rounded-xl px-4 py-3 text-neutral-200 focus:outline-none focus:border-emerald-500/50 transition-all"
                    placeholder="e.g., 1010"
                />
                <p className="mt-1 text-xs text-neutral-500">
                    Optional code for organization (e.g., chart of accounts number).
                </p>
            </div>

            {/* Description */}
            <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">
                    Description
                </label>
                <textarea
                    value={formData.description}
                    onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                    rows={3}
                    className="w-full bg-neutral-950/50 border border-neutral-800 rounded-xl px-4 py-3 text-neutral-200 focus:outline-none focus:border-emerald-500/50 transition-all resize-none"
                    placeholder="Optional description..."
                />
            </div>

            {/* Flags */}
            <div className="flex gap-6">
                <label className="flex items-center gap-3 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={formData.hidden === 1}
                        onChange={e => setFormData(prev => ({ ...prev, hidden: e.target.checked ? 1 : 0 }))}
                        className="w-5 h-5 rounded border-neutral-700 bg-neutral-950 text-emerald-500 focus:ring-emerald-500/50"
                    />
                    <span className="text-sm text-neutral-300">Hidden</span>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={formData.placeholder === 1}
                        onChange={e => setFormData(prev => ({ ...prev, placeholder: e.target.checked ? 1 : 0 }))}
                        className="w-5 h-5 rounded border-neutral-700 bg-neutral-950 text-emerald-500 focus:ring-emerald-500/50"
                    />
                    <span className="text-sm text-neutral-300">Placeholder</span>
                </label>
            </div>

            <p className="text-xs text-neutral-500">
                Placeholder accounts are used for organization and cannot hold transactions directly.
            </p>

            {/* Actions */}
            <div className="flex justify-between items-center pt-4 border-t border-neutral-800">
                <span className="text-xs text-neutral-500">
                    Press <kbd className="px-1.5 py-0.5 bg-neutral-800 rounded border border-neutral-700">Ctrl</kbd> + <kbd className="px-1.5 py-0.5 bg-neutral-800 rounded border border-neutral-700">Enter</kbd> to save
                </span>
                <div className="flex gap-3">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="px-4 py-2 text-sm text-neutral-400 hover:text-neutral-200 transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={saving || !formData.name || !formData.commodity_guid}
                        className="px-6 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
                    >
                        {saving ? 'Saving...' : mode === 'create' ? 'Create Account' : 'Save Changes'}
                    </button>
                </div>
            </div>
        </form>
    );
}
