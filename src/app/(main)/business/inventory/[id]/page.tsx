'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Modal } from '@/components/ui/Modal';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { ItemFormModal } from '@/components/business/ItemFormModal';
import { ItemSelector } from '@/components/business/ItemSelector';
import { MovementsTable } from '@/components/business/MovementsTable';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import { formatCurrency } from '@/lib/format';
import {
    type ItemDTO,
    type ItemDetailDTO,
    type LocationDTO,
    type MovementDTO,
    type BomDTO,
    computeBomDemand,
    computeBomOutput,
    demandShortfalls,
    formatQty,
    parseQty,
    todayIso,
} from '@/components/business/inventory-ui';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;
const inputClass = 'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';
const labelClass = 'block text-xs font-medium text-foreground-secondary mb-1';
const actionButtonClass = 'px-3 py-2 text-sm rounded-lg border border-border bg-surface/50 text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const submitButtonClass = 'px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors';
const cancelButtonClass = 'px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors';

type StockAction = 'receive' | 'ship' | 'adjust' | 'transfer';

async function postMovement(body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch('/api/inventory/movements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'Stock operation failed');
    return data;
}

// ---------------------------------------------------------------------------
// Stock action modal (receive / ship / adjust / transfer)
// ---------------------------------------------------------------------------

const ACTION_TITLES: Record<StockAction, string> = {
    receive: 'Receive Stock',
    ship: 'Ship Stock',
    adjust: 'Adjust Stock',
    transfer: 'Transfer Stock',
};

function StockActionModal({
    action,
    item,
    locations,
    onClose,
    onDone,
}: {
    action: StockAction | null;
    item: ItemDetailDTO;
    locations: LocationDTO[];
    onClose: () => void;
    onDone: () => void;
}) {
    const { success, error } = useToast();
    const [locationId, setLocationId] = useState('');
    const [toLocationId, setToLocationId] = useState('');
    const [quantity, setQuantity] = useState('');
    const [unitCost, setUnitCost] = useState('');
    const [date, setDate] = useState(todayIso());
    const [reference, setReference] = useState('');
    const [post, setPost] = useState(false);
    const [offsetAccountGuid, setOffsetAccountGuid] = useState('');
    const [busy, setBusy] = useState(false);

    const activeLocations = useMemo(() => locations.filter((l) => l.active), [locations]);

    // Reset the form each time the modal opens.
    useEffect(() => {
        if (action) {
            setLocationId(activeLocations.length === 1 ? String(activeLocations[0].id) : '');
            setToLocationId('');
            setQuantity('');
            setUnitCost('');
            setDate(todayIso());
            setReference('');
            setPost(false);
            setOffsetAccountGuid('');
        }
    }, [action, activeLocations]);

    if (!action) return null;

    const canPostShip = !!item.cogsAccountGuid && !!item.assetAccountGuid;
    const onHandAt = (locId: string) =>
        item.stockByLocation.find((s) => String(s.locationId) === locId)?.onHand ?? 0;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const qty = parseQty(quantity);
        if (qty == null || qty === 0) {
            error('Quantity is required');
            return;
        }
        if (action !== 'adjust' && qty < 0) {
            error('Quantity must be positive');
            return;
        }
        if (action === 'transfer') {
            if (!locationId || !toLocationId) {
                error('Both locations are required');
                return;
            }
            if (locationId === toLocationId) {
                error('From and to locations must differ');
                return;
            }
        } else if (!locationId) {
            error('Location is required');
            return;
        }
        const cost = unitCost.trim() === '' ? undefined : Number(unitCost);
        if (cost !== undefined && (!Number.isFinite(cost) || cost < 0)) {
            error('Unit cost must be a non-negative number');
            return;
        }
        if (action === 'receive' && post) {
            if (cost === undefined) {
                error('Unit cost is required when posting to the ledger');
                return;
            }
            if (!offsetAccountGuid) {
                error('An offset account is required when posting to the ledger');
                return;
            }
        }

        setBusy(true);
        try {
            const base = {
                action,
                itemId: item.id,
                quantity: qty,
                date,
                reference: reference.trim() || undefined,
            };
            if (action === 'receive') {
                await postMovement({
                    ...base,
                    locationId: Number(locationId),
                    unitCost: cost,
                    post,
                    offsetAccountGuid: post ? offsetAccountGuid : undefined,
                });
                success(`Received ${formatQty(qty)} ${item.unit}${post ? ' (posted)' : ''}`);
            } else if (action === 'ship') {
                await postMovement({ ...base, locationId: Number(locationId), post });
                success(`Shipped ${formatQty(qty)} ${item.unit}${post ? ' (COGS posted)' : ''}`);
            } else if (action === 'adjust') {
                await postMovement({ ...base, locationId: Number(locationId), unitCost: cost });
                success(`Adjusted stock by ${qty > 0 ? '+' : ''}${formatQty(qty)} ${item.unit}`);
            } else {
                await postMovement({
                    ...base,
                    fromLocationId: Number(locationId),
                    toLocationId: Number(toLocationId),
                });
                success(`Transferred ${formatQty(qty)} ${item.unit}`);
            }
            onClose();
            onDone();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Stock operation failed');
        } finally {
            setBusy(false);
        }
    };

    const locationSelect = (
        value: string,
        onChange: (v: string) => void,
        label: string,
        showOnHand: boolean,
    ) => (
        <div>
            <label className={labelClass}>{label} *</label>
            <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
                <option value="">Select location...</option>
                {activeLocations.map((l) => (
                    <option key={l.id} value={l.id}>
                        {l.name}{showOnHand ? ` (${formatQty(onHandAt(String(l.id)))} on hand)` : ''}
                    </option>
                ))}
            </select>
        </div>
    );

    return (
        <Modal isOpen onClose={busy ? () => {} : onClose} title={ACTION_TITLES[action]} size="md">
            <form onSubmit={handleSubmit} className="px-6 py-4 space-y-3">
                <p className="text-xs text-foreground-muted font-mono tabular-nums" style={TNUM}>
                    {item.sku} — {item.name}
                </p>

                {activeLocations.length === 0 ? (
                    <p className="text-sm text-warning">
                        No active locations yet.{' '}
                        <Link href="/business/inventory/locations" className="text-primary hover:text-primary-hover">
                            Create one first →
                        </Link>
                    </p>
                ) : (
                    <>
                        {action === 'transfer' ? (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                {locationSelect(locationId, setLocationId, 'From', true)}
                                {locationSelect(toLocationId, setToLocationId, 'To', false)}
                            </div>
                        ) : (
                            locationSelect(locationId, setLocationId, 'Location', action !== 'receive')
                        )}

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                                <label className={labelClass}>
                                    Quantity ({item.unit}) *
                                    {action === 'adjust' && (
                                        <span className="ml-1 text-foreground-muted normal-case">signed: + adds, − removes</span>
                                    )}
                                </label>
                                <input
                                    type="number"
                                    step="any"
                                    value={quantity}
                                    onChange={(e) => setQuantity(e.target.value)}
                                    className={`${inputClass} font-mono text-right`}
                                    style={TNUM}
                                    placeholder={action === 'adjust' ? 'e.g. -2' : '0'}
                                    autoFocus
                                />
                            </div>
                            {(action === 'receive' || action === 'adjust') && (
                                <div>
                                    <label className={labelClass}>
                                        Unit cost{action === 'receive' && post ? ' *' : ''}
                                    </label>
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        value={unitCost}
                                        onChange={(e) => setUnitCost(e.target.value)}
                                        className={`${inputClass} font-mono text-right`}
                                        style={TNUM}
                                        placeholder={action === 'adjust' ? `avg ${formatCurrency(item.avgCost)}` : '0.00'}
                                    />
                                </div>
                            )}
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                                <label className={labelClass}>Date</label>
                                <input
                                    type="date"
                                    value={date}
                                    onChange={(e) => setDate(e.target.value)}
                                    className={`${inputClass} font-mono`}
                                    style={TNUM}
                                />
                            </div>
                            <div>
                                <label className={labelClass}>Reference</label>
                                <input
                                    type="text"
                                    value={reference}
                                    onChange={(e) => setReference(e.target.value)}
                                    className={inputClass}
                                    placeholder="PO / memo (optional)"
                                />
                            </div>
                        </div>

                        {action === 'receive' && (
                            <div className="space-y-2 pt-1">
                                <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                                    <input
                                        type="checkbox"
                                        checked={post}
                                        onChange={(e) => setPost(e.target.checked)}
                                        className="accent-primary"
                                    />
                                    Post to ledger (debit inventory asset, credit offset)
                                </label>
                                {post && (
                                    <div>
                                        <label className={labelClass}>Offset account *</label>
                                        <AccountSelector
                                            value={offsetAccountGuid}
                                            onChange={(guid) => setOffsetAccountGuid(guid)}
                                            placeholder="e.g. a bank or payable account"
                                        />
                                        {!item.assetAccountGuid && (
                                            <p className="mt-1 text-xs text-warning">
                                                This item has no asset account set — posting will fail. Set it via Edit item.
                                            </p>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        {action === 'ship' && (
                            <div className="pt-1">
                                <label className={`flex items-center gap-2 text-sm ${canPostShip ? 'text-foreground-secondary' : 'text-foreground-muted'}`}>
                                    <input
                                        type="checkbox"
                                        checked={post}
                                        onChange={(e) => setPost(e.target.checked)}
                                        disabled={!canPostShip}
                                        className="accent-primary"
                                    />
                                    Post COGS to ledger (avg cost × quantity)
                                </label>
                                {!canPostShip && (
                                    <p className="mt-1 text-xs text-foreground-muted">
                                        Requires COGS and asset accounts on the item — set them via Edit item.
                                    </p>
                                )}
                            </div>
                        )}

                        {action === 'adjust' && (
                            <p className="text-xs text-foreground-muted">
                                Adjustments never post to the ledger. Positive adjustments with a unit cost
                                update the moving average cost.
                            </p>
                        )}
                        {action === 'transfer' && (
                            <p className="text-xs text-foreground-muted">
                                Transfers move stock between locations and never post to the ledger.
                            </p>
                        )}
                    </>
                )}

                <div className="flex justify-end gap-3 pt-2 border-t border-border">
                    <button type="button" onClick={onClose} disabled={busy} className={cancelButtonClass}>
                        Cancel
                    </button>
                    <button type="submit" disabled={busy || activeLocations.length === 0} className={submitButtonClass}>
                        {busy ? 'Working...' : ACTION_TITLES[action]}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

// ---------------------------------------------------------------------------
// BOM editor modal
// ---------------------------------------------------------------------------

interface BomLineDraft {
    key: string;
    componentItemId: number | null;
    quantity: string;
}

let lineKeySeq = 0;
const nextLineKey = () => `line-${++lineKeySeq}`;

function BomEditorModal({
    editing,
    item,
    items,
    onClose,
    onSaved,
}: {
    /** null = closed, 'new' = create, BomDTO = edit. */
    editing: 'new' | BomDTO | null;
    item: ItemDetailDTO;
    items: ItemDTO[];
    onClose: () => void;
    onSaved: () => void;
}) {
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();
    const [name, setName] = useState('');
    const [outputQuantity, setOutputQuantity] = useState('1');
    const [lines, setLines] = useState<BomLineDraft[]>([]);
    const [saving, setSaving] = useState(false);

    const isNew = editing === 'new';

    useEffect(() => {
        if (editing === 'new') {
            setName('');
            setOutputQuantity('1');
            setLines([{ key: nextLineKey(), componentItemId: null, quantity: '1' }]);
        } else if (editing) {
            setName(editing.name);
            setOutputQuantity(String(editing.outputQuantity));
            setLines(editing.lines.map((l) => ({
                key: nextLineKey(),
                componentItemId: l.componentItemId,
                quantity: String(l.quantity),
            })));
        }
    }, [editing]);

    if (!editing) return null;

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim()) {
            error('Name is required');
            return;
        }
        const outQty = parseQty(outputQuantity);
        if (outQty == null || outQty <= 0) {
            error('Output quantity must be a positive number');
            return;
        }
        const payloadLines: Array<{ componentItemId: number; quantity: number }> = [];
        for (const line of lines) {
            if (line.componentItemId == null && line.quantity.trim() === '') continue;
            if (line.componentItemId == null) {
                error('Every component line needs an item');
                return;
            }
            const qty = parseQty(line.quantity);
            if (qty == null || qty <= 0) {
                error('Component quantities must be positive numbers');
                return;
            }
            payloadLines.push({ componentItemId: line.componentItemId, quantity: qty });
        }
        if (payloadLines.length === 0) {
            error('A BOM requires at least one component line');
            return;
        }

        setSaving(true);
        try {
            const url = isNew ? '/api/inventory/boms' : `/api/inventory/boms/${(editing as BomDTO).id}`;
            const res = await fetch(url, {
                method: isNew ? 'POST' : 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...(isNew ? { itemId: item.id } : {}),
                    name: name.trim(),
                    outputQuantity: outQty,
                    lines: payloadLines,
                }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to save BOM');
            success(isNew ? 'BOM created' : 'BOM updated');
            onClose();
            onSaved();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save BOM');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal isOpen onClose={onClose} title={isNew ? 'New BOM' : 'Edit BOM'} size="lg">
            <form onSubmit={handleSave} className="px-6 py-4 space-y-3">
                <p className="text-xs text-foreground-muted">
                    Produces <span className="font-mono tabular-nums" style={TNUM}>{item.sku}</span> — {item.name}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="sm:col-span-2">
                        <label className={labelClass}>Name *</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className={inputClass}
                            placeholder="e.g. Standard build"
                            autoFocus
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Output qty per batch *</label>
                        <input
                            type="number"
                            min="0"
                            step="any"
                            value={outputQuantity}
                            onChange={(e) => setOutputQuantity(e.target.value)}
                            className={`${inputClass} font-mono text-right`}
                            style={TNUM}
                        />
                    </div>
                </div>

                <div>
                    <h3 className="text-sm font-semibold text-foreground mb-2">Components</h3>
                    <div className="space-y-2">
                        {lines.map((line) => (
                            <div key={line.key} className="flex items-center gap-2">
                                <ItemSelector
                                    value={line.componentItemId}
                                    onChange={(id) =>
                                        setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, componentItemId: id } : l)))
                                    }
                                    items={items}
                                    excludeItemIds={[item.id]}
                                    placeholder="Component item..."
                                    compact
                                    className="flex-1 min-w-0"
                                />
                                <input
                                    type="number"
                                    min="0"
                                    step="any"
                                    value={line.quantity}
                                    onChange={(e) =>
                                        setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, quantity: e.target.value } : l)))
                                    }
                                    className={`${inputClass} font-mono text-right w-24 shrink-0`}
                                    style={TNUM}
                                    placeholder="Qty"
                                    title="Quantity per batch"
                                />
                                <button
                                    type="button"
                                    onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                                    disabled={lines.length <= 1}
                                    className="px-1.5 py-0.5 text-xs rounded-md text-foreground-muted hover:text-negative hover:bg-negative/10 transition-colors disabled:opacity-40 shrink-0"
                                    title="Remove component"
                                >
                                    ✕
                                </button>
                            </div>
                        ))}
                    </div>
                    <button
                        type="button"
                        onClick={() => setLines((prev) => [...prev, { key: nextLineKey(), componentItemId: null, quantity: '1' }])}
                        className="mt-2 px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                    >
                        + Add component
                    </button>
                </div>

                <div className="flex justify-end gap-3 pt-2 border-t border-border">
                    <button type="button" onClick={onClose} className={cancelButtonClass}>Cancel</button>
                    <button
                        type="submit"
                        disabled={saving || isReadonly}
                        title={isReadonly ? READONLY_TOOLTIP : undefined}
                        className={submitButtonClass}
                    >
                        {saving ? 'Saving...' : 'Save BOM'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

// ---------------------------------------------------------------------------
// Assemble modal
// ---------------------------------------------------------------------------

function AssembleModal({
    bom,
    item,
    items,
    locations,
    onClose,
    onDone,
}: {
    bom: BomDTO | null;
    item: ItemDetailDTO;
    items: ItemDTO[];
    locations: LocationDTO[];
    onClose: () => void;
    onDone: () => void;
}) {
    const { success, error } = useToast();
    const [batches, setBatches] = useState('1');
    const [locationId, setLocationId] = useState('');
    const [date, setDate] = useState(todayIso());
    const [reference, setReference] = useState('');
    const [post, setPost] = useState(false);
    const [busy, setBusy] = useState(false);

    const activeLocations = useMemo(() => locations.filter((l) => l.active), [locations]);
    const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

    useEffect(() => {
        if (bom) {
            setBatches('1');
            setLocationId(activeLocations.length === 1 ? String(activeLocations[0].id) : '');
            setDate(todayIso());
            setReference('');
            setPost(false);
        }
    }, [bom, activeLocations]);

    const batchCount = parseQty(batches) ?? 0;
    const demand = useMemo(
        () => (bom ? computeBomDemand(bom, batchCount) : []),
        [bom, batchCount],
    );
    const onHandByItemId = useMemo(
        () => new Map(items.map((i) => [i.id, i.onHand])),
        [items],
    );
    const shortfalls = useMemo(
        () => new Set(demandShortfalls(demand, onHandByItemId).map((d) => d.componentItemId)),
        [demand, onHandByItemId],
    );

    if (!bom) return null;

    const output = computeBomOutput(bom, batchCount);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (batchCount <= 0) {
            error('Batches must be a positive number');
            return;
        }
        if (!locationId) {
            error('Location is required');
            return;
        }
        setBusy(true);
        try {
            const res = await fetch(`/api/inventory/boms/${bom.id}/assemble`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    batches: batchCount,
                    locationId: Number(locationId),
                    date,
                    reference: reference.trim() || undefined,
                    post,
                }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Assembly failed');
            success(
                `Assembled ${formatQty(data.producedQuantity)} ${item.unit} at ${formatCurrency(data.unitCost)} avg cost each`,
            );
            onClose();
            onDone();
        } catch (err) {
            // Insufficient component stock arrives here as the API's 409 message.
            error(err instanceof Error ? err.message : 'Assembly failed');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal isOpen onClose={busy ? () => {} : onClose} title={`Assemble — ${bom.name}`} size="md">
            <form onSubmit={handleSubmit} className="px-6 py-4 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <label className={labelClass}>Batches *</label>
                        <input
                            type="number"
                            min="0"
                            step="any"
                            value={batches}
                            onChange={(e) => setBatches(e.target.value)}
                            className={`${inputClass} font-mono text-right`}
                            style={TNUM}
                            autoFocus
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Location *</label>
                        <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className={inputClass}>
                            <option value="">Select location...</option>
                            {activeLocations.map((l) => (
                                <option key={l.id} value={l.id}>{l.name}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label className={labelClass}>Date</label>
                        <input
                            type="date"
                            value={date}
                            onChange={(e) => setDate(e.target.value)}
                            className={`${inputClass} font-mono`}
                            style={TNUM}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Reference</label>
                        <input
                            type="text"
                            value={reference}
                            onChange={(e) => setReference(e.target.value)}
                            className={inputClass}
                            placeholder="Optional"
                        />
                    </div>
                </div>

                {/* Component demand preview */}
                <div className="border border-border rounded-lg overflow-hidden">
                    <table className="w-full text-left text-[13px]">
                        <thead>
                            <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                <th className="px-3 py-1.5 font-semibold">Component</th>
                                <th className="px-3 py-1.5 font-semibold text-right">Required</th>
                                <th className="px-3 py-1.5 font-semibold text-right">On hand</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {demand.map((d) => {
                                const component = itemById.get(d.componentItemId);
                                const short = shortfalls.has(d.componentItemId);
                                return (
                                    <tr key={d.componentItemId}>
                                        <td className="px-3 py-1.5 text-foreground-secondary truncate">
                                            {component ? `${component.sku} — ${component.name}` : `#${d.componentItemId}`}
                                        </td>
                                        <td
                                            className={`px-3 py-1.5 font-mono tabular-nums text-right ${short ? 'text-negative' : 'text-foreground'}`}
                                            style={TNUM}
                                        >
                                            {formatQty(d.required)}
                                        </td>
                                        <td className="px-3 py-1.5 font-mono tabular-nums text-right text-foreground-secondary" style={TNUM}>
                                            {formatQty(onHandByItemId.get(d.componentItemId) ?? 0)}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                        <tfoot>
                            <tr className="border-t border-border">
                                <td className="px-3 py-1.5 text-foreground font-medium">Produces</td>
                                <td className="px-3 py-1.5 font-mono tabular-nums text-right text-foreground font-medium" style={TNUM}>
                                    {formatQty(output)} {item.unit}
                                </td>
                                <td />
                            </tr>
                        </tfoot>
                    </table>
                </div>
                {shortfalls.size > 0 && (
                    <p className="text-xs text-warning">
                        Book-wide stock may be insufficient for the highlighted components. Stock is
                        checked per location on submit.
                    </p>
                )}

                <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                    <input
                        type="checkbox"
                        checked={post}
                        onChange={(e) => setPost(e.target.checked)}
                        className="accent-primary"
                    />
                    Post asset transfer between differing component/output asset accounts
                </label>

                <div className="flex justify-end gap-3 pt-2 border-t border-border">
                    <button type="button" onClick={onClose} disabled={busy} className={cancelButtonClass}>
                        Cancel
                    </button>
                    <button type="submit" disabled={busy} className={submitButtonClass}>
                        {busy ? 'Assembling...' : 'Assemble'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function InventoryItemPage() {
    const params = useParams<{ id: string }>();
    const router = useRouter();
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();
    const itemId = parseInt(params.id, 10);

    const [item, setItem] = useState<ItemDetailDTO | null>(null);
    const [items, setItems] = useState<ItemDTO[]>([]);
    const [locations, setLocations] = useState<LocationDTO[]>([]);
    const [movements, setMovements] = useState<MovementDTO[]>([]);
    const [movementsTotal, setMovementsTotal] = useState(0);
    const [boms, setBoms] = useState<BomDTO[]>([]);
    const [loading, setLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);

    const [stockAction, setStockAction] = useState<StockAction | null>(null);
    const [editingItem, setEditingItem] = useState<ItemDTO | null>(null);
    const [editingBom, setEditingBom] = useState<'new' | BomDTO | null>(null);
    const [assembling, setAssembling] = useState<BomDTO | null>(null);
    const [deactivating, setDeactivating] = useState(false);
    const [isDeactivating, setIsDeactivating] = useState(false);

    const MOVE_PAGE = 50;

    const fetchItem = useCallback(async () => {
        try {
            const res = await fetch(`/api/inventory/items/${itemId}`);
            if (res.status === 404) {
                setNotFound(true);
                return;
            }
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to load item');
            setItem(data.item);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load item');
        }
    }, [itemId, error]);

    const fetchItems = useCallback(async () => {
        try {
            const res = await fetch('/api/inventory/items');
            const data = await res.json().catch(() => null);
            if (res.ok) setItems(data.items);
        } catch { /* selectors degrade gracefully */ }
    }, []);

    const fetchMovements = useCallback(async () => {
        try {
            const res = await fetch(`/api/inventory/movements?itemId=${itemId}&limit=${MOVE_PAGE}`);
            const data = await res.json().catch(() => null);
            if (res.ok) {
                setMovements(data.movements);
                setMovementsTotal(data.total);
            }
        } catch { /* history section shows empty state */ }
    }, [itemId]);

    const fetchBoms = useCallback(async () => {
        try {
            const res = await fetch(`/api/inventory/boms?itemId=${itemId}&includeInactive=true`);
            const data = await res.json().catch(() => null);
            if (res.ok) setBoms(data.boms);
        } catch { /* BOM section shows empty state */ }
    }, [itemId]);

    useEffect(() => {
        if (!Number.isInteger(itemId) || itemId <= 0) {
            setNotFound(true);
            setLoading(false);
            return;
        }
        Promise.all([
            fetchItem(),
            fetchItems(),
            fetchMovements(),
            fetchBoms(),
            fetch('/api/inventory/locations?includeInactive=true')
                .then((res) => (res.ok ? res.json() : { locations: [] }))
                .then((data: { locations: LocationDTO[] }) => setLocations(data.locations ?? []))
                .catch(() => {}),
        ]).finally(() => setLoading(false));
    }, [itemId, fetchItem, fetchItems, fetchMovements, fetchBoms]);

    const refreshAfterMovement = useCallback(() => {
        fetchItem();
        fetchItems();
        fetchMovements();
    }, [fetchItem, fetchItems, fetchMovements]);

    const loadMoreMovements = async () => {
        setLoadingMore(true);
        try {
            const res = await fetch(
                `/api/inventory/movements?itemId=${itemId}&limit=${MOVE_PAGE}&offset=${movements.length}`,
            );
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to load movements');
            setMovements((prev) => [...prev, ...data.movements]);
            setMovementsTotal(data.total);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load movements');
        } finally {
            setLoadingMore(false);
        }
    };

    const handleDeactivate = async () => {
        setIsDeactivating(true);
        try {
            const res = await fetch(`/api/inventory/items/${itemId}`, { method: 'DELETE' });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to deactivate item');
            success(`Deactivated ${item?.sku ?? 'item'}`);
            router.push('/business/inventory');
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to deactivate item');
            setIsDeactivating(false);
            setDeactivating(false);
        }
    };

    const handleBomToggle = async (bom: BomDTO) => {
        try {
            const res = await fetch(`/api/inventory/boms/${bom.id}`, {
                method: bom.active ? 'DELETE' : 'PUT',
                ...(bom.active
                    ? {}
                    : {
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ active: true }),
                    }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to update BOM');
            success(bom.active ? `Deactivated BOM "${bom.name}"` : `Activated BOM "${bom.name}"`);
            await fetchBoms();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to update BOM');
        }
    };

    const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
    const locationById = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations]);

    if (notFound) {
        return (
            <div className="p-12 text-center text-foreground-muted">
                Item not found.{' '}
                <Link href="/business/inventory" className="text-primary hover:text-primary-hover">
                    Back to inventory
                </Link>
            </div>
        );
    }

    if (loading || !item) {
        return (
            <div className="p-12 flex items-center justify-center gap-3">
                <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                <span className="text-foreground-secondary">Loading item...</span>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <PageHeader
                title={`${item.sku} — ${item.name}`}
                subtitle={item.description || `Unit: ${item.unit}`}
                actions={
                    <button
                        type="button"
                        onClick={() => setEditingItem(item)}
                        disabled={isReadonly}
                        title={isReadonly ? READONLY_TOOLTIP : undefined}
                        className="px-4 py-2 text-sm bg-surface-hover hover:bg-border text-foreground rounded-lg transition-colors"
                    >
                        Edit Item
                    </button>
                }
                menuActions={[
                    ...(item.active
                        ? [{ label: 'Deactivate', onSelect: () => setDeactivating(true), destructive: true, disabled: isReadonly }]
                        : []),
                ]}
            />

            <div className="flex items-center gap-3 text-sm">
                <Link href="/business/inventory" className="text-foreground-muted hover:text-foreground transition-colors">
                    ← All items
                </Link>
                {!item.active && (
                    <span className="inline-block px-2 py-0.5 text-xs rounded-md bg-surface-hover text-foreground-muted">
                        Inactive
                    </span>
                )}
            </div>

            <StatGrid cols={4}>
                <StatCard
                    label="On hand"
                    value={formatQty(item.onHand)}
                    sub={item.unit}
                    tone={item.onHand <= 0 ? 'warning' : 'default'}
                    size="compact"
                />
                <StatCard label="Avg cost" value={formatCurrency(item.avgCost)} sub="moving average" size="compact" />
                <StatCard label="Stock value" value={formatCurrency(item.stockValue)} sub="at avg cost" size="compact" />
                <StatCard
                    label="Sale price"
                    value={item.salePrice != null ? formatCurrency(item.salePrice) : '—'}
                    size="compact"
                />
            </StatGrid>

            {/* Stock actions */}
            <div className="flex items-center gap-2 flex-wrap">
                <button
                    type="button"
                    onClick={() => setStockAction('receive')}
                    disabled={isReadonly}
                    title={isReadonly ? READONLY_TOOLTIP : undefined}
                    className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                >
                    Receive
                </button>
                <button
                    type="button"
                    onClick={() => setStockAction('ship')}
                    disabled={isReadonly}
                    title={isReadonly ? READONLY_TOOLTIP : undefined}
                    className={actionButtonClass}
                >
                    Ship
                </button>
                <button
                    type="button"
                    onClick={() => setStockAction('adjust')}
                    disabled={isReadonly}
                    title={isReadonly ? READONLY_TOOLTIP : undefined}
                    className={actionButtonClass}
                >
                    Adjust
                </button>
                <button
                    type="button"
                    onClick={() => setStockAction('transfer')}
                    disabled={isReadonly || item.stockByLocation.length === 0}
                    title={isReadonly ? READONLY_TOOLTIP : undefined}
                    className={actionButtonClass}
                >
                    Transfer
                </button>
            </div>

            {/* Stock by location */}
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
                <div className="px-4 py-2.5 border-b border-border">
                    <h2 className="text-sm font-semibold text-foreground">Stock by location</h2>
                </div>
                {item.stockByLocation.length === 0 ? (
                    <p className="px-4 py-4 text-sm text-foreground-muted">
                        No stock movements yet — receive stock to get started.
                    </p>
                ) : (
                    <table className="w-full text-left text-[13px]">
                        <thead>
                            <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                <th className="px-4 py-2 font-semibold">Location</th>
                                <th className="px-4 py-2 font-semibold text-right">On hand</th>
                                <th className="px-4 py-2 font-semibold text-right">Value (avg cost)</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {item.stockByLocation.map((s) => (
                                <tr key={s.locationId} className="hover:bg-surface-hover/50 transition-colors">
                                    <td className="px-4 py-2 text-foreground">{s.locationName}</td>
                                    <td className="px-4 py-2 font-mono tabular-nums text-right text-foreground" style={TNUM}>
                                        {formatQty(s.onHand)}
                                    </td>
                                    <td className="px-4 py-2 font-mono tabular-nums text-right text-foreground-secondary" style={TNUM}>
                                        {formatCurrency(s.onHand * item.avgCost)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* BOMs */}
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
                <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-foreground">Bills of materials</h2>
                    <button
                        type="button"
                        onClick={() => setEditingBom('new')}
                        disabled={isReadonly}
                        title={isReadonly ? READONLY_TOOLTIP : undefined}
                        className="px-2 py-1 text-xs rounded-md text-primary hover:bg-primary-light transition-colors disabled:opacity-50"
                    >
                        + New BOM
                    </button>
                </div>
                {boms.length === 0 ? (
                    <p className="px-4 py-4 text-sm text-foreground-muted">
                        No BOMs yet. A BOM lets you assemble this item from component items.
                    </p>
                ) : (
                    <table className="w-full text-left text-[13px]">
                        <thead>
                            <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                <th className="px-4 py-2 font-semibold">Name</th>
                                <th className="px-4 py-2 font-semibold text-right">Output / batch</th>
                                <th className="px-4 py-2 font-semibold">Components</th>
                                <th className="px-4 py-2 font-semibold">Status</th>
                                <th className="px-4 py-2 font-semibold text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {boms.map((bom) => (
                                <tr key={bom.id} className="hover:bg-surface-hover/50 transition-colors">
                                    <td className="px-4 py-2 text-foreground">{bom.name}</td>
                                    <td className="px-4 py-2 font-mono tabular-nums text-right text-foreground-secondary" style={TNUM}>
                                        {formatQty(bom.outputQuantity)} {item.unit}
                                    </td>
                                    <td className="px-4 py-2 text-foreground-secondary max-w-72 truncate">
                                        {bom.lines
                                            .map((l) => {
                                                const c = itemById.get(l.componentItemId);
                                                return `${formatQty(l.quantity)}× ${c ? c.sku : `#${l.componentItemId}`}`;
                                            })
                                            .join(', ')}
                                    </td>
                                    <td className="px-4 py-2">
                                        {bom.active ? (
                                            <span className="inline-block px-2 py-0.5 text-xs rounded-md bg-positive/10 text-positive">Active</span>
                                        ) : (
                                            <span className="inline-block px-2 py-0.5 text-xs rounded-md bg-surface-hover text-foreground-muted">Inactive</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-2 text-right whitespace-nowrap">
                                        <button
                                            type="button"
                                            onClick={() => setAssembling(bom)}
                                            disabled={isReadonly || !bom.active}
                                            title={isReadonly ? READONLY_TOOLTIP : undefined}
                                            className="px-2 py-1 text-xs rounded-md text-primary hover:bg-primary-light transition-colors disabled:opacity-50"
                                        >
                                            Assemble
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setEditingBom(bom)}
                                            className="ml-1 px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                                        >
                                            Edit
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => handleBomToggle(bom)}
                                            disabled={isReadonly}
                                            title={isReadonly ? READONLY_TOOLTIP : undefined}
                                            className="ml-1 px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
                                        >
                                            {bom.active ? 'Deactivate' : 'Activate'}
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Movement history */}
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
                <div className="px-4 py-2.5 border-b border-border">
                    <h2 className="text-sm font-semibold text-foreground">Movement history</h2>
                </div>
                <MovementsTable
                    movements={movements}
                    locationLabel={(id) => locationById.get(id)?.name ?? `#${id}`}
                    emptyMessage="No movements for this item yet."
                />
                {movements.length < movementsTotal && (
                    <div className="px-4 py-3 border-t border-border text-center">
                        <button
                            type="button"
                            onClick={loadMoreMovements}
                            disabled={loadingMore}
                            className="px-3 py-1.5 text-xs rounded-md text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
                        >
                            {loadingMore ? 'Loading...' : `Load more (${movements.length} of ${movementsTotal})`}
                        </button>
                    </div>
                )}
            </div>

            {/* Modals */}
            <StockActionModal
                action={stockAction}
                item={item}
                locations={locations}
                onClose={() => setStockAction(null)}
                onDone={refreshAfterMovement}
            />
            <ItemFormModal
                editing={editingItem}
                onClose={() => setEditingItem(null)}
                onSaved={() => { fetchItem(); fetchItems(); }}
            />
            <BomEditorModal
                editing={editingBom}
                item={item}
                items={items}
                onClose={() => setEditingBom(null)}
                onSaved={fetchBoms}
            />
            <AssembleModal
                bom={assembling}
                item={item}
                items={items}
                locations={locations}
                onClose={() => setAssembling(null)}
                onDone={() => { refreshAfterMovement(); fetchBoms(); }}
            />
            <ConfirmationDialog
                isOpen={deactivating}
                onConfirm={handleDeactivate}
                onCancel={() => setDeactivating(false)}
                title="Deactivate Item"
                message={`Deactivate ${item.sku} — ${item.name}? The item is hidden from pickers but its movement history is preserved.`}
                confirmLabel="Deactivate"
                confirmVariant="danger"
                isLoading={isDeactivating}
            />
        </div>
    );
}
