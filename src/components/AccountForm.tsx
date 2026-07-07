'use client';

import { useState, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useFormKeyboardShortcuts } from '@/lib/hooks/useFormKeyboardShortcuts';
import { useHouseholdNames } from '@/lib/hooks/useHouseholdNames';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { TagPicker, type SelectedTag } from '@/components/tags/TagPicker';
import type { Tag } from '@/lib/tags';

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
    commodity_scu?: number;
    code: string;
    description: string;
    hidden: number;
    placeholder: number;
    notes: string;
    tax_related: boolean;
    is_retirement: boolean;
    retirement_account_type: string | null;
    owner: string | null; // 'self' | 'spouse' | 'joint' | null (null = unset; retirement code treats unset as self)
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
    fraction?: number;
}

const SECURITY_ACCOUNT_TYPES = new Set(['STOCK', 'MUTUAL']);

// Balance-sheet account types that can carry an owner attribution
// (banks, cash, brokerages, liabilities). Income/expense/equity accounts
// don't have a meaningful owner.
const OWNER_ELIGIBLE_ACCOUNT_TYPES = new Set([
    'ASSET', 'BANK', 'CASH', 'STOCK', 'MUTUAL', 'RECEIVABLE',
    'LIABILITY', 'CREDIT', 'PAYABLE',
]);

const OWNER_VALUES = new Set(['self', 'spouse', 'joint']);

// HSAs are the one "retirement" type that can cover the whole family, so the
// Owner select additionally offers Family (stored as 'joint') for them.
const HSA_RETIREMENT_TYPES = new Set(['hsa', 'hsa_family']);

function isCurrencyCommodity(c: Commodity): boolean {
    return c.namespace === 'CURRENCY' || c.namespace === 'ISO4217';
}

interface AccountFormProps {
    mode: 'create' | 'edit';
    accountGuid?: string;
    initialData?: Partial<AccountFormData>;
    parentGuid?: string | null; // Pre-selected parent for "New Child" action
    onSave: (data: AccountFormData) => Promise<void>;
    onCancel: () => void;
}

export function AccountForm({ mode, accountGuid, initialData, parentGuid, onSave, onCancel }: AccountFormProps) {
    const [formData, setFormData] = useState<AccountFormData>({
        name: initialData?.name || '',
        account_type: initialData?.account_type || 'ASSET',
        parent_guid: parentGuid ?? initialData?.parent_guid ?? null,
        commodity_guid: initialData?.commodity_guid || '',
        commodity_scu: initialData?.commodity_scu,
        code: initialData?.code || '',
        description: initialData?.description || '',
        hidden: initialData?.hidden ?? 0,
        placeholder: initialData?.placeholder ?? 0,
        notes: initialData?.notes ?? '',
        tax_related: initialData?.tax_related ?? false,
        is_retirement: initialData?.is_retirement ?? false,
        retirement_account_type: initialData?.retirement_account_type ?? null,
        owner: initialData?.owner ?? null,
    });

    const [accounts, setAccounts] = useState<FlatAccount[]>([]);
    const [commodities, setCommodities] = useState<Commodity[]>([]);
    const [splitsCount, setSplitsCount] = useState<number | null>(mode === 'create' ? 0 : null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const formRef = useRef<HTMLFormElement>(null);
    const queryClient = useQueryClient();
    const { selfName, spouseName } = useHouseholdNames();

    // Tags (edit mode only -- new accounts don't have a guid yet)
    const [tags, setTags] = useState<SelectedTag[]>([]);
    const [tagsDirty, setTagsDirty] = useState(false);

    useEffect(() => {
        if (mode !== 'edit' || !accountGuid) return;
        let cancelled = false;
        fetch(`/api/accounts/${accountGuid}/tags`)
            .then(res => (res.ok ? res.json() : []))
            .then((data: Tag[]) => {
                if (!cancelled) setTags(data.map(t => ({ name: t.name, color: t.color })));
            })
            .catch(() => { /* tags are optional; leave empty */ });
        return () => { cancelled = true; };
    }, [mode, accountGuid]);

    // In edit mode, seed the owner from account preferences when the caller
    // didn't provide it in initialData (older callers only pass retirement fields).
    const initialOwnerProvided = initialData?.owner !== undefined;
    useEffect(() => {
        if (mode !== 'edit' || !accountGuid || initialOwnerProvided) return;
        let cancelled = false;
        fetch(`/api/accounts/${accountGuid}/preferences`)
            .then(res => (res.ok ? res.json() : null))
            .then((prefs: { owner?: string | null } | null) => {
                if (cancelled || !prefs) return;
                const owner = prefs.owner && OWNER_VALUES.has(prefs.owner) ? prefs.owner : null;
                setFormData(prev => ({ ...prev, owner }));
            })
            .catch(() => { /* owner is optional; leave default */ });
        return () => { cancelled = true; };
    }, [mode, accountGuid, initialOwnerProvided]);

    const isSecurityAccount = SECURITY_ACCOUNT_TYPES.has(formData.account_type);

    // Partition commodities into currencies vs securities so we can show the
    // correct list based on account type.
    const { currencies, securities } = (() => {
        const currencies: Commodity[] = [];
        const securities: Commodity[] = [];
        for (const c of commodities) {
            if (isCurrencyCommodity(c)) currencies.push(c);
            else securities.push(c);
        }
        return { currencies, securities };
    })();
    const commodityOptions = isSecurityAccount ? securities : currencies;

    const commodityLocked = mode === 'edit' && (splitsCount ?? 0) > 0;

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
                    const comms: Commodity[] = await commoditiesRes.json();
                    setCommodities(comms);
                    // Default to USD only for non-security accounts on create.
                    // Security accounts (STOCK/MUTUAL) start blank so the user
                    // explicitly picks the security.
                    setFormData(prev => {
                        if (prev.commodity_guid || comms.length === 0) {
                            return prev;
                        }
                        if (SECURITY_ACCOUNT_TYPES.has(prev.account_type)) {
                            return prev;
                        }
                        const usd = comms.find(c => c.mnemonic === 'USD' && isCurrencyCommodity(c));
                        const firstCurrency = comms.find(isCurrencyCommodity);
                        return {
                            ...prev,
                            commodity_guid: usd?.guid || firstCurrency?.guid || '',
                        };
                    });
                }
            } catch (err) {
                console.error('Error fetching form data:', err);
            } finally {
                setLoading(false);
            }
        }

        fetchData();
    }, []);

    // In edit mode, fetch the splits count to decide whether the commodity
    // selector is locked. Server enforces this too, but we want to surface it
    // in the UI so the user understands why before they try to save.
    useEffect(() => {
        if (mode !== 'edit' || !accountGuid) return;
        let cancelled = false;
        fetch(`/api/accounts/${accountGuid}/info`)
            .then(res => res.ok ? res.json() : null)
            .then(info => {
                if (cancelled || !info) return;
                const count = typeof info.splits_count === 'number'
                    ? info.splits_count
                    : Number(info.splits_count ?? 0);
                setSplitsCount(Number.isFinite(count) ? count : 0);
            })
            .catch(() => { if (!cancelled) setSplitsCount(0); });
        return () => { cancelled = true; };
    }, [mode, accountGuid]);

    // When the account type flips between security and currency in create
    // mode, clear any selected commodity from the other partition so we don't
    // submit (e.g.) USD on a STOCK account.
    useEffect(() => {
        if (mode !== 'create') return;
        if (!formData.commodity_guid) return;
        const selected = commodities.find(c => c.guid === formData.commodity_guid);
        if (!selected) return;
        const selectedIsSecurity = !isCurrencyCommodity(selected);
        if (selectedIsSecurity !== isSecurityAccount) {
            setFormData(prev => ({ ...prev, commodity_guid: '' }));
        }
    }, [formData.account_type, isSecurityAccount, formData.commodity_guid, commodities, mode]);

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
        if (!commodityLocked && !formData.commodity_guid) {
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

            // Persist tags separately (edit mode only)
            if (mode === 'edit' && accountGuid && tagsDirty) {
                const res = await fetch(`/api/accounts/${accountGuid}/tags`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tags: tags.map(t => t.name) }),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => null);
                    throw new Error(data?.error || 'Account saved, but updating tags failed');
                }
                queryClient.invalidateQueries({ queryKey: ['tags'] });
            }
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
                <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
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
                <label className="block text-sm font-medium text-foreground-secondary mb-2">
                    Account Name <span className="text-rose-400">*</span>
                </label>
                <input
                    type="text"
                    required
                    data-field="name"
                    value={formData.name}
                    onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    className={`w-full bg-input-bg border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:border-primary/50 transition-all ${
                        fieldErrors.name ? 'border-rose-500 ring-1 ring-rose-500/30' : 'border-border'
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
                    <label className="block text-sm font-medium text-foreground-secondary mb-2">
                        Account Type <span className="text-rose-400">*</span>
                    </label>
                    <select
                        required
                        value={formData.account_type}
                        onChange={e => setFormData(prev => ({ ...prev, account_type: e.target.value }))}
                        className="w-full bg-input-bg border border-border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:border-primary/50 transition-all cursor-pointer"
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
                    <div className="flex items-baseline justify-between mb-2">
                        <label className="block text-sm font-medium text-foreground-secondary">
                            Parent Account
                        </label>
                        {formData.parent_guid && (
                            <button
                                type="button"
                                onClick={() => setFormData(prev => ({ ...prev, parent_guid: null }))}
                                className="text-xs text-foreground-muted hover:text-foreground underline-offset-2 hover:underline"
                            >
                                Use top level
                            </button>
                        )}
                    </div>
                    <AccountSelector
                        value={formData.parent_guid || ''}
                        onChange={(guid) => setFormData(prev => ({ ...prev, parent_guid: guid || null }))}
                        placeholder="(Top Level)"
                    />
                    <p className="mt-1 text-xs text-foreground-muted">
                        Select a parent to create a sub-account, or leave as top level.
                    </p>
                </div>
            )}

            {/* Commodity (currency or security depending on account type) */}
            <div>
                <label className="block text-sm font-medium text-foreground-secondary mb-2">
                    {isSecurityAccount ? 'Security' : 'Currency'} <span className="text-rose-400">*</span>
                </label>
                <select
                    required
                    data-field="commodity_guid"
                    value={formData.commodity_guid}
                    disabled={commodityLocked}
                    onChange={e => {
                        const newGuid = e.target.value;
                        const picked = commodities.find(c => c.guid === newGuid);
                        setFormData(prev => ({
                            ...prev,
                            commodity_guid: newGuid,
                            // For securities, default the SCU to the commodity's
                            // native fraction so finer precisions (e.g. FSMDX = 1e6)
                            // aren't truncated by a stale default.
                            ...(picked && !isCurrencyCommodity(picked) && picked.fraction
                                ? { commodity_scu: picked.fraction }
                                : {}),
                        }));
                    }}
                    className={`w-full bg-input-bg border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:border-primary/50 transition-all ${
                        commodityLocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                    } ${
                        fieldErrors.commodity_guid ? 'border-rose-500 ring-1 ring-rose-500/30' : 'border-border'
                    }`}
                >
                    <option value="">
                        {isSecurityAccount ? '(Select a security...)' : '(Select a currency...)'}
                    </option>
                    {commodityOptions.map(comm => (
                        <option key={comm.guid} value={comm.guid}>
                            {comm.mnemonic} - {comm.fullname || comm.mnemonic}
                        </option>
                    ))}
                </select>
                {commodityLocked ? (
                    <p className="mt-1 text-xs text-foreground-muted">
                        Locked: this account has {splitsCount} transaction split{splitsCount === 1 ? '' : 's'}. Remove all transactions to change the {isSecurityAccount ? 'security' : 'currency'}.
                    </p>
                ) : isSecurityAccount && commodityOptions.length === 0 ? (
                    <p className="mt-1 text-xs text-amber-400">
                        No securities defined yet. Add one in the Commodities editor first.
                    </p>
                ) : null}
                {fieldErrors.commodity_guid && (
                    <p className="mt-1 text-xs text-rose-400">{fieldErrors.commodity_guid}</p>
                )}
            </div>

            {/* Smallest Currency Unit (share precision) — shown for investment types */}
            {['STOCK', 'MUTUAL'].includes(formData.account_type) && (
                <div>
                    <label className="block text-sm font-medium text-foreground-secondary mb-2">
                        Share Decimal Places
                    </label>
                    <select
                        value={formData.commodity_scu ?? 10000}
                        onChange={e => setFormData(prev => ({ ...prev, commodity_scu: Number(e.target.value) }))}
                        className="w-full bg-input-bg border border-border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:border-primary/50 transition-all cursor-pointer"
                    >
                        <option value={1}>0 (whole shares)</option>
                        <option value={10}>1</option>
                        <option value={100}>2</option>
                        <option value={1000}>3</option>
                        <option value={10000}>4</option>
                        <option value={100000}>5</option>
                        <option value={1000000}>6</option>
                    </select>
                    <p className="mt-1 text-xs text-foreground-muted">
                        Number of decimal places for share quantities (GnuCash smallest currency unit).
                    </p>
                </div>
            )}

            {/* Account Code */}
            <div>
                <label className="block text-sm font-medium text-foreground-secondary mb-2">
                    Account Code
                </label>
                <input
                    type="text"
                    value={formData.code}
                    onChange={e => setFormData(prev => ({ ...prev, code: e.target.value }))}
                    className="w-full bg-input-bg border border-border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:border-primary/50 transition-all"
                    placeholder="e.g., 1010"
                />
                <p className="mt-1 text-xs text-foreground-muted">
                    Optional code for organization (e.g., chart of accounts number).
                </p>
            </div>

            {/* Description */}
            <div>
                <label className="block text-sm font-medium text-foreground-secondary mb-2">
                    Description
                </label>
                <textarea
                    value={formData.description}
                    onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                    rows={3}
                    className="w-full bg-input-bg border border-border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:border-primary/50 transition-all resize-none"
                    placeholder="Optional description..."
                />
            </div>

            {/* Tags (edit mode only) */}
            {mode === 'edit' && accountGuid && (
                <div>
                    <label className="block text-sm font-medium text-foreground-secondary mb-2">
                        Tags
                    </label>
                    <TagPicker
                        selected={tags}
                        onChange={(next) => { setTags(next); setTagsDirty(true); }}
                        placeholder="Add tags (e.g. vacation, rental-property)..."
                    />
                    <p className="mt-1 text-xs text-foreground-muted">
                        Account tags apply to all of the account&apos;s transactions when searching with #tag.
                    </p>
                </div>
            )}

            {/* Flags */}
            <div className="flex gap-6">
                <label className="flex items-center gap-3 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={formData.hidden === 1}
                        onChange={e => setFormData(prev => ({ ...prev, hidden: e.target.checked ? 1 : 0 }))}
                        className="w-5 h-5 rounded border-border-hover bg-background text-primary focus:ring-primary/50"
                    />
                    <span className="text-sm text-foreground-secondary">Hidden</span>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={formData.placeholder === 1}
                        onChange={e => setFormData(prev => ({ ...prev, placeholder: e.target.checked ? 1 : 0 }))}
                        className="w-5 h-5 rounded border-border-hover bg-background text-primary focus:ring-primary/50"
                    />
                    <span className="text-sm text-foreground-secondary">Placeholder</span>
                </label>
            </div>

            <p className="text-xs text-foreground-muted">
                Placeholder accounts are used for organization and cannot hold transactions directly.
            </p>

            {/* Tax & retirement flags */}
            <div className="space-y-3 border-t border-border pt-4">
                <p className="text-xs text-foreground-muted">
                    Tax marking, in two places: tag an expense account with{' '}
                    <span className="text-foreground-secondary font-medium">#taxes</span> (Tags below) to include
                    it in the dashboard&rsquo;s Taxes chart; map accounts to{' '}
                    <span className="text-foreground-secondary font-medium">tax categories</span> in the Tax
                    Estimator (Edit account mapping) to drive tax calculations. The retirement flag here marks
                    the account tax-sheltered.
                </p>
                <div className="flex flex-wrap gap-6">
                    <label className="flex items-center gap-3 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={formData.is_retirement}
                            onChange={e => setFormData(prev => ({
                                ...prev,
                                is_retirement: e.target.checked,
                                retirement_account_type: e.target.checked ? prev.retirement_account_type : null,
                                // Retirement accounts are individually owned; a joint
                                // owner isn't valid there — except HSAs, which can
                                // cover the whole family. Keep self/spouse as-is when
                                // toggling either way.
                                owner: e.target.checked
                                    && prev.owner === 'joint'
                                    && !HSA_RETIREMENT_TYPES.has(prev.retirement_account_type ?? '')
                                    ? 'self'
                                    : prev.owner,
                            }))}
                            className="w-5 h-5 rounded border-border-hover bg-background text-primary focus:ring-primary/50"
                        />
                        <span className="text-sm text-foreground-secondary">Retirement account</span>
                    </label>

                    {formData.is_retirement && (
                        <select
                            value={formData.retirement_account_type ?? ''}
                            onChange={e => setFormData(prev => ({
                                ...prev,
                                retirement_account_type: e.target.value || null,
                                // Family (joint) ownership is only valid for HSA
                                // types; reset to Self when switching away.
                                owner: prev.owner === 'joint' && !HSA_RETIREMENT_TYPES.has(e.target.value)
                                    ? 'self'
                                    : prev.owner,
                            }))}
                            className="bg-input-bg border border-border rounded-lg px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary/50"
                        >
                            <option value="">Select type...</option>
                            <option value="401k">401(k)</option>
                            <option value="403b">403(b)</option>
                            <option value="457">457</option>
                            <option value="traditional_ira">Traditional IRA</option>
                            <option value="roth_ira">Roth IRA</option>
                            <option value="sep_ira">SEP IRA</option>
                            <option value="simple_ira">SIMPLE IRA</option>
                            <option value="hsa">HSA (self-only)</option>
                            <option value="hsa_family">HSA (family coverage)</option>
                            <option value="hra">HRA</option>
                            <option value="fsa">FSA</option>
                            <option value="education_529">529 Plan</option>
                            <option value="coverdell_esa">Coverdell ESA</option>
                            <option value="brokerage">Brokerage (taxable)</option>
                        </select>
                    )}

                    {OWNER_ELIGIBLE_ACCOUNT_TYPES.has(formData.account_type) && (
                        <label className="flex items-center gap-2 cursor-pointer">
                            <span className="text-sm text-foreground-secondary">Owner</span>
                            {formData.is_retirement ? (
                                // Retirement accounts are individually owned: no Joint,
                                // and unset displays as Self (matching how the reports
                                // attribute unset retirement owners). HSAs additionally
                                // allow Family (stored as 'joint') since one HSA can
                                // cover the whole household.
                                <select
                                    value={
                                        formData.owner === 'spouse'
                                            ? 'spouse'
                                            : formData.owner === 'joint'
                                                && HSA_RETIREMENT_TYPES.has(formData.retirement_account_type ?? '')
                                                ? 'joint'
                                                : 'self'
                                    }
                                    onChange={e => setFormData(prev => ({
                                        ...prev,
                                        owner: OWNER_VALUES.has(e.target.value) ? e.target.value : 'self',
                                    }))}
                                    className="bg-input-bg border border-border rounded-lg px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary/50"
                                >
                                    <option value="self">{selfName ?? 'Self'}</option>
                                    <option value="spouse">{spouseName ?? 'Spouse'}</option>
                                    {HSA_RETIREMENT_TYPES.has(formData.retirement_account_type ?? '') && (
                                        <option value="joint">Family</option>
                                    )}
                                </select>
                            ) : (
                                <select
                                    value={formData.owner && OWNER_VALUES.has(formData.owner) ? formData.owner : ''}
                                    onChange={e => setFormData(prev => ({
                                        ...prev,
                                        owner: e.target.value || null,
                                    }))}
                                    className="bg-input-bg border border-border rounded-lg px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary/50"
                                >
                                    <option value="">—</option>
                                    <option value="self">{selfName ?? 'Self'}</option>
                                    <option value="spouse">{spouseName ?? 'Spouse'}</option>
                                    <option value="joint">Joint</option>
                                </select>
                            )}
                        </label>
                    )}
                </div>
                <p className="text-xs text-foreground-muted">
                    Retirement flags drive the Contribution Summary report, IRS limit tracking,
                    and the Tax Estimator. Flag the top-level account; children inherit it.
                    Owner attributes the account to you, your spouse, or both: it drives
                    per-person limit tracking for retirement accounts and ownership reporting
                    (Net Worth by Owner). Children inherit the nearest ancestor&apos;s owner.
                </p>
            </div>

            {/* Actions */}
            <div className="flex flex-col-reverse sm:flex-row sm:justify-between sm:items-center gap-3 pt-4 border-t border-border">
                <span className="hidden sm:inline text-xs text-foreground-muted">
                    Press <kbd className="px-1.5 py-0.5 bg-background-tertiary rounded border border-border-hover">Ctrl</kbd> + <kbd className="px-1.5 py-0.5 bg-background-tertiary rounded border border-border-hover">Enter</kbd> to save
                </span>
                <div className="flex flex-wrap gap-3 justify-end">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={saving || !formData.name || !formData.commodity_guid}
                        className="px-6 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                    >
                        {saving ? 'Saving...' : mode === 'create' ? 'Create Account' : 'Save Changes'}
                    </button>
                </div>
            </div>
        </form>
    );
}
