'use client';

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { Abbr } from '@/components/ui/Abbr';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import {
    POSTING_ACCOUNT_TYPES,
    type ItemDTO,
    type ValuationMethod,
} from '@/components/business/inventory-ui';
import { ApiRequestError, extractErrorMessage } from '@/lib/api-error';
import { Tip } from '@/components/ui/Tooltip';

const inputClass = 'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';
const labelClass = 'block text-xs font-medium text-foreground-secondary mb-1';
const TNUM = { fontFeatureSettings: "'tnum'" } as const;

interface ItemForm {
    sku: string;
    name: string;
    description: string;
    unit: string;
    salePrice: string;
    incomeAccountGuid: string;
    cogsAccountGuid: string;
    assetAccountGuid: string;
    postToLedger: boolean;
    valuationMethod: ValuationMethod;
    reorderPoint: string;
    reorderQuantity: string;
    active: boolean;
}

const EMPTY_FORM: ItemForm = {
    sku: '',
    name: '',
    description: '',
    unit: 'ea',
    salePrice: '',
    incomeAccountGuid: '',
    cogsAccountGuid: '',
    assetAccountGuid: '',
    postToLedger: true,
    valuationMethod: 'average',
    reorderPoint: '',
    reorderQuantity: '',
    active: true,
};

function itemToForm(item: ItemDTO): ItemForm {
    return {
        sku: item.sku,
        name: item.name,
        description: item.description ?? '',
        unit: item.unit,
        salePrice: item.salePrice != null ? String(item.salePrice) : '',
        incomeAccountGuid: item.incomeAccountGuid ?? '',
        cogsAccountGuid: item.cogsAccountGuid ?? '',
        assetAccountGuid: item.assetAccountGuid ?? '',
        postToLedger: item.postToLedger !== false,
        valuationMethod: item.valuationMethod ?? 'average',
        reorderPoint: item.reorderPoint != null ? String(item.reorderPoint) : '',
        reorderQuantity: item.reorderQuantity != null ? String(item.reorderQuantity) : '',
        active: item.active,
    };
}

interface ItemFormModalProps {
    /** null = closed, 'new' = create, ItemDTO = edit. */
    editing: 'new' | ItemDTO | null;
    onClose: () => void;
    /** Called with the saved item after a successful create/update. */
    onSaved: (item: ItemDTO) => void;
}

/**
 * Shared create/edit modal for inventory items: sku, name, description, unit,
 * sale price, and the three posting accounts (income/COGS/asset) with a
 * "Create default accounts" bootstrap shortcut for COGS + asset.
 */
export function ItemFormModal({ editing, onClose, onSaved }: ItemFormModalProps) {
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();
    const [form, setForm] = useState<ItemForm>(EMPTY_FORM);
    const [saving, setSaving] = useState(false);
    const [bootstrapping, setBootstrapping] = useState(false);
    /** Per-field messages from the API's 400 `errors: [{ field, message }]` body. */
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

    const isNew = editing === 'new';
    const isOpen = editing !== null;

    useEffect(() => {
        setFieldErrors({});
        if (editing === 'new') setForm(EMPTY_FORM);
        else if (editing) setForm(itemToForm(editing));
    }, [editing]);

    const postingFieldLabels: Record<string, string> = {
        incomeAccountGuid: 'Income account',
        cogsAccountGuid: 'COGS account',
        assetAccountGuid: 'Asset account',
    };

    const handleBootstrap = async () => {
        setBootstrapping(true);
        try {
            const res = await fetch('/api/inventory/bootstrap-accounts', { method: 'POST' });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(extractErrorMessage(data, 'Failed to create default accounts'));
            setForm((f) => ({
                ...f,
                cogsAccountGuid: data.cogsAccountGuid ?? f.cogsAccountGuid,
                assetAccountGuid: data.assetAccountGuid ?? f.assetAccountGuid,
            }));
            success('Default Inventory and COGS accounts ready');
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to create default accounts');
        } finally {
            setBootstrapping(false);
        }
    };

    const handleSave = async () => {
        if (!form.sku.trim()) {
            error('SKU is required');
            return;
        }
        if (!form.name.trim()) {
            error('Name is required');
            return;
        }
        const salePrice = form.salePrice.trim() === '' ? null : Number(form.salePrice);
        if (salePrice !== null && (!Number.isFinite(salePrice) || salePrice < 0)) {
            error('Sale price must be a non-negative number');
            return;
        }
        const reorderPoint = form.reorderPoint.trim() === '' ? null : Number(form.reorderPoint);
        if (reorderPoint !== null && (!Number.isFinite(reorderPoint) || reorderPoint < 0)) {
            error('Reorder point must be a non-negative number');
            return;
        }
        const reorderQuantity = form.reorderQuantity.trim() === '' ? null : Number(form.reorderQuantity);
        if (reorderQuantity !== null && (!Number.isFinite(reorderQuantity) || reorderQuantity < 0)) {
            error('Reorder quantity must be a non-negative number');
            return;
        }
        // Posting is either on — and then all three accounts are required,
        // matching the server's save-time rule — or off, and the item is
        // stock-only. Catching it here saves a round trip; the server check is
        // still the authority.
        if (form.postToLedger) {
            const missing = (['incomeAccountGuid', 'cogsAccountGuid', 'assetAccountGuid'] as const)
                .filter((f) => !form[f]);
            if (missing.length > 0) {
                setFieldErrors(Object.fromEntries(missing.map((f) => [f, 'Required for ledger posting'])));
                error(`${missing.map((f) => postingFieldLabels[f]).join(', ')} required while ledger posting is on`);
                return;
            }
        }
        setFieldErrors({});
        setSaving(true);
        try {
            const payload = {
                sku: form.sku.trim(),
                name: form.name.trim(),
                description: form.description.trim() || null,
                unit: form.unit.trim() || 'ea',
                salePrice,
                incomeAccountGuid: form.incomeAccountGuid || null,
                cogsAccountGuid: form.cogsAccountGuid || null,
                assetAccountGuid: form.assetAccountGuid || null,
                postToLedger: form.postToLedger,
                valuationMethod: form.valuationMethod,
                reorderPoint,
                reorderQuantity,
                ...(isNew ? {} : { active: form.active }),
            };
            const url = isNew ? '/api/inventory/items' : `/api/inventory/items/${(editing as ItemDTO).id}`;
            const res = await fetch(url, {
                method: isNew ? 'POST' : 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
                // One reader for every error-body shape the API emits — the
                // banner message and the per-field entries come out of the same
                // parse instead of this call site hand-picking `data.fields`.
                const failure = ApiRequestError.fromBody(data, 'Failed to save item', res.status);
                setFieldErrors(failure.fieldErrors);
                throw failure;
            }
            success(isNew ? `Item ${payload.sku} created` : 'Item updated');
            onSaved(data.item);
            onClose();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save item');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={isNew ? 'New Item' : 'Edit Item'} size="lg">
            <form
                className="px-6 py-4 space-y-4"
                onSubmit={(e) => {
                    e.preventDefault();
                    handleSave();
                }}
            >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <label className={labelClass}>SKU *</label>
                        <input
                            type="text"
                            value={form.sku}
                            onChange={(e) => setForm({ ...form, sku: e.target.value })}
                            className={`${inputClass} font-mono`}
                            style={TNUM}
                            placeholder="e.g. WID-001"
                            maxLength={64}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Name *</label>
                        <input
                            type="text"
                            value={form.name}
                            onChange={(e) => setForm({ ...form, name: e.target.value })}
                            className={inputClass}
                            placeholder="Item name"
                        />
                    </div>
                    <div className="sm:col-span-2">
                        <label className={labelClass}>Description</label>
                        <input
                            type="text"
                            value={form.description}
                            onChange={(e) => setForm({ ...form, description: e.target.value })}
                            className={inputClass}
                            placeholder="Optional description..."
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Unit</label>
                        <input
                            type="text"
                            value={form.unit}
                            onChange={(e) => setForm({ ...form, unit: e.target.value })}
                            className={inputClass}
                            placeholder="ea"
                            maxLength={16}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Sale price</label>
                        <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={form.salePrice}
                            onChange={(e) => setForm({ ...form, salePrice: e.target.value })}
                            className={`${inputClass} font-mono text-right`}
                            style={TNUM}
                            placeholder="Optional"
                        />
                    </div>
                </div>

                <div className="pt-2 border-t border-border">
                    <h3 className="text-sm font-semibold text-foreground mb-2">Valuation &amp; reorder</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                            <label className={labelClass}>Valuation method</label>
                            <select
                                value={form.valuationMethod}
                                onChange={(e) => setForm({ ...form, valuationMethod: e.target.value as ValuationMethod })}
                                className={inputClass}
                            >
                                <option value="average">Moving average</option>
                                <option value="fifo">FIFO</option>
                            </select>
                            <p className="mt-1 text-[11px] text-foreground-muted">
                                {form.valuationMethod === 'fifo'
                                    ? <><Abbr term="FIFO" /> consumes the oldest receipts first.</>
                                    : 'Blends the unit cost across receipts.'}
                            </p>
                        </div>
                        <div>
                            <label className={labelClass}>Reorder point</label>
                            <input
                                type="number"
                                min="0"
                                step="any"
                                value={form.reorderPoint}
                                onChange={(e) => setForm({ ...form, reorderPoint: e.target.value })}
                                className={`${inputClass} font-mono text-right`}
                                style={TNUM}
                                placeholder="No alert"
                                aria-label="Alert when total on-hand is at or below this quantity"
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Reorder quantity</label>
                            <input
                                type="number"
                                min="0"
                                step="any"
                                value={form.reorderQuantity}
                                onChange={(e) => setForm({ ...form, reorderQuantity: e.target.value })}
                                className={`${inputClass} font-mono text-right`}
                                style={TNUM}
                                placeholder="Optional"
                                aria-label="Suggested quantity to reorder (shown in the alert)"
                            />
                        </div>
                    </div>
                    {!isNew && editing && (editing as ItemDTO).valuationMethod !== form.valuationMethod && (
                        <p className="mt-2 text-xs text-warning">
                            Changing the valuation method affects future consumption only — past
                            movements and postings are not revalued.
                        </p>
                    )}
                </div>

                <div className="pt-2 border-t border-border">
                    <div className="flex items-center justify-between mb-2">
                        <h3 className="text-sm font-semibold text-foreground">Posting accounts</h3>
                        <Tip content={isReadonly ? READONLY_TOOLTIP : 'Create default Inventory (asset) and Cost of Goods Sold (expense) accounts'}>
                        <button
                            type="button"
                            onClick={handleBootstrap}
                            disabled={bootstrapping || isReadonly}
                            className="px-2 py-1 text-xs rounded-md text-primary hover:bg-primary-light transition-colors disabled:opacity-50"
                        >
                            {bootstrapping ? 'Creating...' : 'Create default accounts'}
                        </button>
                        </Tip>
                    </div>
                    <label className="flex items-start gap-2 text-sm text-foreground-secondary mb-2">
                        <input
                            type="checkbox"
                            checked={form.postToLedger}
                            onChange={(e) => setForm({ ...form, postToLedger: e.target.checked })}
                            className="accent-primary mt-0.5"
                        />
                        <span>
                            Post this item&rsquo;s movements to the ledger
                            <span className="block text-xs text-foreground-muted">
                                On: all three accounts below are required, and shipping records{' '}
                                <Abbr term="COGS" /> automatically. Off: the item is tracked for stock
                                only and the accounts may stay empty.
                            </span>
                        </span>
                    </label>
                    <p className="text-xs text-foreground-muted mb-2">
                        Receiving with post also needs an offset account, chosen at receive time.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        {/* Types come from the shared POSTING_ACCOUNT_TYPES so this
                            picker and the server-side validation cannot disagree. */}
                        {([
                            { field: 'incomeAccountGuid', label: 'Income account' },
                            { field: 'cogsAccountGuid', label: 'COGS account' },
                            { field: 'assetAccountGuid', label: 'Asset account' },
                        ] as const).map(({ field, label }) => (
                            <div key={field}>
                                <label className={labelClass}>
                                    {label}{form.postToLedger ? ' *' : ''}
                                </label>
                                <AccountSelector
                                    value={form[field]}
                                    onChange={(guid) => setForm((f) => ({ ...f, [field]: guid }))}
                                    accountTypes={[...POSTING_ACCOUNT_TYPES[field]]}
                                    placeholder={form.postToLedger ? 'Required' : 'Optional'}
                                    compact
                                />
                                {fieldErrors[field] && (
                                    <p className="mt-1 text-[11px] text-error">{fieldErrors[field]}</p>
                                )}
                            </div>
                        ))}
                    </div>
                </div>

                {!isNew && (
                    <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                        <input
                            type="checkbox"
                            checked={form.active}
                            onChange={(e) => setForm({ ...form, active: e.target.checked })}
                            className="accent-primary"
                        />
                        Active
                    </label>
                )}

                <div className="flex justify-end gap-3 pt-2 border-t border-border">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                    >
                        Cancel
                    </button>
                    <Tip content={isReadonly ? READONLY_TOOLTIP : undefined}>
                    <button
                        type="submit"
                        disabled={saving || isReadonly}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                    >
                        {saving ? 'Saving...' : 'Save'}
                    </button>
                    </Tip>
                </div>
            </form>
        </Modal>
    );
}
