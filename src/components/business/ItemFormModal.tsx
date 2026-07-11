'use client';

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import type { ItemDTO } from '@/components/business/inventory-ui';

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

    const isNew = editing === 'new';
    const isOpen = editing !== null;

    useEffect(() => {
        if (editing === 'new') setForm(EMPTY_FORM);
        else if (editing) setForm(itemToForm(editing));
    }, [editing]);

    const handleBootstrap = async () => {
        setBootstrapping(true);
        try {
            const res = await fetch('/api/inventory/bootstrap-accounts', { method: 'POST' });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to create default accounts');
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
                ...(isNew ? {} : { active: form.active }),
            };
            const url = isNew ? '/api/inventory/items' : `/api/inventory/items/${(editing as ItemDTO).id}`;
            const res = await fetch(url, {
                method: isNew ? 'POST' : 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to save item');
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
                    <div className="flex items-center justify-between mb-2">
                        <h3 className="text-sm font-semibold text-foreground">Posting accounts</h3>
                        <button
                            type="button"
                            onClick={handleBootstrap}
                            disabled={bootstrapping || isReadonly}
                            title={isReadonly ? READONLY_TOOLTIP : 'Create default Inventory (asset) and Cost of Goods Sold (expense) accounts'}
                            className="px-2 py-1 text-xs rounded-md text-primary hover:bg-primary-light transition-colors disabled:opacity-50"
                        >
                            {bootstrapping ? 'Creating...' : 'Create default accounts'}
                        </button>
                    </div>
                    <p className="text-xs text-foreground-muted mb-2">
                        Only needed for posting to the ledger: shipping with post requires COGS + asset accounts;
                        receiving with post also needs an offset account at receive time.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                            <label className={labelClass}>Income account</label>
                            <AccountSelector
                                value={form.incomeAccountGuid}
                                onChange={(guid) => setForm((f) => ({ ...f, incomeAccountGuid: guid }))}
                                accountTypes={['INCOME']}
                                placeholder="Optional"
                                compact
                            />
                        </div>
                        <div>
                            <label className={labelClass}>COGS account</label>
                            <AccountSelector
                                value={form.cogsAccountGuid}
                                onChange={(guid) => setForm((f) => ({ ...f, cogsAccountGuid: guid }))}
                                accountTypes={['EXPENSE']}
                                placeholder="Optional"
                                compact
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Asset account</label>
                            <AccountSelector
                                value={form.assetAccountGuid}
                                onChange={(guid) => setForm((f) => ({ ...f, assetAccountGuid: guid }))}
                                accountTypes={['ASSET']}
                                placeholder="Optional"
                                compact
                            />
                        </div>
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
                    <button
                        type="submit"
                        disabled={saving || isReadonly}
                        title={isReadonly ? READONLY_TOOLTIP : undefined}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                    >
                        {saving ? 'Saving...' : 'Save'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
