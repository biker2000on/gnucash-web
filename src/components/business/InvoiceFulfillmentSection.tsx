'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ItemSelector } from '@/components/business/ItemSelector';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import {
    type FulfillmentDTO,
    type FulfillmentEntryDTO,
    type ItemDTO,
    type LocationDTO,
    defaultItemIdForEntry,
    formatQty,
    parseQty,
    todayIso,
} from '@/components/business/inventory-ui';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;
const inputClass = 'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';
const labelClass = 'block text-xs font-medium text-foreground-secondary mb-1';

export interface FulfillmentEntryInfo {
    guid: string;
    description: string;
    quantity: number;
}

interface InvoiceFulfillmentSectionProps {
    invoiceGuid: string;
    /** Invoice entries (guid, description, quantity) for row labels. */
    entries: FulfillmentEntryInfo[];
}

type Mode = 'fulfill' | 'return';

interface AllocationDraft {
    entryGuid: string;
    description: string;
    /** Max quantity for this mode (remaining for fulfill, fulfilled for return). */
    max: number;
    itemId: number | null;
    quantity: string;
    locationId: string;
}

function AllocationModal({
    mode,
    invoiceGuid,
    fulfillment,
    entryInfo,
    items,
    locations,
    onClose,
    onDone,
}: {
    mode: Mode | null;
    invoiceGuid: string;
    fulfillment: FulfillmentDTO;
    entryInfo: Map<string, FulfillmentEntryInfo>;
    items: ItemDTO[];
    locations: LocationDTO[];
    onClose: () => void;
    onDone: () => void;
}) {
    const { success, error } = useToast();
    const [rows, setRows] = useState<AllocationDraft[]>([]);
    const [date, setDate] = useState(todayIso());
    const [post, setPost] = useState(false);
    const [busy, setBusy] = useState(false);

    const activeLocations = useMemo(() => locations.filter((l) => l.active), [locations]);

    useEffect(() => {
        if (!mode) return;
        const defaultLocation = activeLocations.length === 1 ? String(activeLocations[0].id) : '';
        const eligible = fulfillment.entries.filter((e: FulfillmentEntryDTO) =>
            mode === 'fulfill' ? e.remainingQuantity > 0 : e.fulfilledQuantity > 0,
        );
        setRows(eligible.map((e) => {
            const max = mode === 'fulfill' ? e.remainingQuantity : e.fulfilledQuantity;
            return {
                entryGuid: e.entryGuid,
                description: entryInfo.get(e.entryGuid)?.description || '(no description)',
                max,
                itemId: defaultItemIdForEntry(e),
                quantity: String(max),
                locationId: defaultLocation,
            };
        }));
        setDate(todayIso());
        setPost(false);
    }, [mode, fulfillment, entryInfo, activeLocations]);

    if (!mode) return null;

    const title = mode === 'fulfill' ? 'Fulfill Invoice' : 'Return to Stock';

    const updateRow = (entryGuid: string, patch: Partial<AllocationDraft>) => {
        setRows((prev) => prev.map((r) => (r.entryGuid === entryGuid ? { ...r, ...patch } : r)));
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const allocations: Array<{ entryGuid: string; itemId: number; quantity: number; locationId: number }> = [];
        for (const row of rows) {
            const qty = parseQty(row.quantity);
            // Blank or zero quantity = skip this line.
            if (qty == null || qty === 0) continue;
            if (qty < 0) {
                error('Quantities must be positive');
                return;
            }
            if (qty > row.max + 1e-9) {
                error(`"${row.description}" exceeds the ${mode === 'fulfill' ? 'remaining' : 'fulfilled'} quantity (${formatQty(row.max)})`);
                return;
            }
            if (row.itemId == null) {
                error(`Pick an inventory item for "${row.description}"`);
                return;
            }
            if (!row.locationId) {
                error(`Pick a location for "${row.description}"`);
                return;
            }
            allocations.push({
                entryGuid: row.entryGuid,
                itemId: row.itemId,
                quantity: qty,
                locationId: Number(row.locationId),
            });
        }
        if (allocations.length === 0) {
            error('Nothing to submit — set a quantity on at least one line');
            return;
        }

        setBusy(true);
        try {
            const res = await fetch(`/api/inventory/invoices/${invoiceGuid}/fulfillment`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode, allocations, date, post }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || `Failed to ${mode === 'fulfill' ? 'fulfill' : 'return'}`);
            success(mode === 'fulfill' ? 'Stock shipped against invoice' : 'Stock returned');
            onClose();
            onDone();
        } catch (err) {
            // 409 (insufficient stock / unposted invoice) and 400 (over-fulfillment)
            // arrive here with the API's message.
            error(err instanceof Error ? err.message : 'Operation failed');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal isOpen onClose={busy ? () => {} : onClose} title={title} size="xl">
            <form onSubmit={handleSubmit} className="px-6 py-4 space-y-3">
                <p className="text-sm text-foreground-secondary">
                    {mode === 'fulfill'
                        ? 'Ship inventory against this invoice. Pick the item each line refers to — invoice lines carry no item link. Leave a quantity blank to skip a line.'
                        : 'Return previously fulfilled quantities to stock. Leave a quantity blank to skip a line.'}
                </p>

                {activeLocations.length === 0 && (
                    <p className="text-sm text-warning">No active inventory locations — create one first.</p>
                )}

                <div className="border border-border rounded-lg overflow-x-auto">
                    <table className="w-full text-left text-[13px]">
                        <thead>
                            <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                <th className="px-3 py-2 font-semibold min-w-40">Invoice line</th>
                                <th className="px-3 py-2 font-semibold min-w-52">Item</th>
                                <th className="px-3 py-2 font-semibold text-right w-28">
                                    Qty <span className="normal-case">(max {mode === 'fulfill' ? 'remaining' : 'fulfilled'})</span>
                                </th>
                                <th className="px-3 py-2 font-semibold min-w-36">Location</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {rows.map((row) => (
                                <tr key={row.entryGuid} className="align-top">
                                    <td className="px-3 py-2 text-foreground-secondary">
                                        <div className="truncate max-w-56">{row.description}</div>
                                        <div className="text-xs text-foreground-muted font-mono tabular-nums" style={TNUM}>
                                            max {formatQty(row.max)}
                                        </div>
                                    </td>
                                    <td className="px-2 py-1.5">
                                        <ItemSelector
                                            value={row.itemId}
                                            onChange={(id) => updateRow(row.entryGuid, { itemId: id })}
                                            items={items}
                                            compact
                                        />
                                    </td>
                                    <td className="px-2 py-1.5">
                                        <input
                                            type="number"
                                            min="0"
                                            step="any"
                                            value={row.quantity}
                                            onChange={(e) => updateRow(row.entryGuid, { quantity: e.target.value })}
                                            className="w-full bg-input-bg border border-border rounded-md px-2 py-1 text-[13px] font-mono text-right text-foreground focus:outline-none focus:border-primary/50"
                                            style={TNUM}
                                        />
                                    </td>
                                    <td className="px-2 py-1.5">
                                        <select
                                            value={row.locationId}
                                            onChange={(e) => updateRow(row.entryGuid, { locationId: e.target.value })}
                                            className="w-full bg-input-bg border border-border rounded-md px-2 py-1 text-[13px] text-foreground focus:outline-none focus:border-primary/50"
                                        >
                                            <option value="">Location...</option>
                                            {activeLocations.map((l) => (
                                                <option key={l.id} value={l.id}>{l.name}</option>
                                            ))}
                                        </select>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                <div className="flex flex-wrap items-end gap-4">
                    <div>
                        <label className={labelClass}>Date</label>
                        <input
                            type="date"
                            value={date}
                            onChange={(e) => setDate(e.target.value)}
                            className={`${inputClass} font-mono w-44`}
                            style={TNUM}
                        />
                    </div>
                    <label className="flex items-center gap-2 text-sm text-foreground-secondary pb-2.5">
                        <input
                            type="checkbox"
                            checked={post}
                            onChange={(e) => setPost(e.target.checked)}
                            className="accent-primary"
                        />
                        {mode === 'fulfill'
                            ? 'Post COGS to ledger (needs COGS + asset accounts on each item)'
                            : 'Post reversing COGS to ledger'}
                    </label>
                </div>

                <div className="flex justify-end gap-3 pt-2 border-t border-border">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={busy}
                        className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={busy || activeLocations.length === 0}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                    >
                        {busy ? 'Working...' : mode === 'fulfill' ? 'Fulfill' : 'Return'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

/**
 * Fulfillment panel for a POSTED customer invoice: per-entry invoiced /
 * fulfilled / remaining quantities plus Fulfill / Return flows backed by
 * /api/inventory/invoices/[guid]/fulfillment. Renders nothing until the
 * fulfillment view loads; loads lazily and stays out of the way of the
 * existing invoice behavior.
 */
export function InvoiceFulfillmentSection({ invoiceGuid, entries }: InvoiceFulfillmentSectionProps) {
    const { isReadonly } = useCurrentUser();
    const [fulfillment, setFulfillment] = useState<FulfillmentDTO | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [items, setItems] = useState<ItemDTO[]>([]);
    const [locations, setLocations] = useState<LocationDTO[]>([]);
    const [mode, setMode] = useState<Mode | null>(null);

    const fetchFulfillment = useCallback(async () => {
        try {
            const res = await fetch(`/api/inventory/invoices/${invoiceGuid}/fulfillment`);
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to load fulfillment');
            setFulfillment(data.fulfillment);
            setLoadError(null);
        } catch (err) {
            setLoadError(err instanceof Error ? err.message : 'Failed to load fulfillment');
        } finally {
            setLoading(false);
        }
    }, [invoiceGuid]);

    useEffect(() => { fetchFulfillment(); }, [fetchFulfillment]);

    // Reference data for the allocation modal (best-effort).
    useEffect(() => {
        fetch('/api/inventory/items')
            .then((res) => (res.ok ? res.json() : { items: [] }))
            .then((data: { items: ItemDTO[] }) => setItems(data.items ?? []))
            .catch(() => {});
        fetch('/api/inventory/locations')
            .then((res) => (res.ok ? res.json() : { locations: [] }))
            .then((data: { locations: LocationDTO[] }) => setLocations(data.locations ?? []))
            .catch(() => {});
    }, []);

    const entryInfo = useMemo(
        () => new Map(entries.map((e) => [e.guid, e])),
        [entries],
    );

    if (loading) return null;

    const canFulfill = fulfillment?.entries.some((e) => e.remainingQuantity > 0) ?? false;
    const canReturn = fulfillment?.entries.some((e) => e.fulfilledQuantity > 0) ?? false;

    return (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold text-foreground">Fulfillment</h2>
                    {fulfillment?.fullyFulfilled && (
                        <span className="inline-block px-2 py-0.5 text-xs rounded-md bg-positive/10 text-positive">
                            Fully fulfilled
                        </span>
                    )}
                </div>
                {fulfillment && (
                    <div className="flex items-center gap-1.5">
                        <button
                            type="button"
                            onClick={() => setMode('return')}
                            disabled={isReadonly || !canReturn}
                            title={isReadonly ? READONLY_TOOLTIP : !canReturn ? 'Nothing has been fulfilled yet' : undefined}
                            className="px-2.5 py-1 text-xs rounded-md text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Return...
                        </button>
                        <button
                            type="button"
                            onClick={() => setMode('fulfill')}
                            disabled={isReadonly || !canFulfill}
                            title={isReadonly ? READONLY_TOOLTIP : !canFulfill ? 'All lines are fully fulfilled' : undefined}
                            className="px-2.5 py-1 text-xs rounded-md bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground transition-colors"
                        >
                            Fulfill...
                        </button>
                    </div>
                )}
            </div>

            {loadError ? (
                <p className="px-4 py-4 text-sm text-foreground-muted">{loadError}</p>
            ) : !fulfillment || fulfillment.entries.length === 0 ? (
                <p className="px-4 py-4 text-sm text-foreground-muted">No fulfillable lines on this invoice.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-[13px]">
                        <thead>
                            <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                <th className="px-4 py-2 font-semibold">Line</th>
                                <th className="px-4 py-2 font-semibold text-right">Invoiced</th>
                                <th className="px-4 py-2 font-semibold text-right">Fulfilled</th>
                                <th className="px-4 py-2 font-semibold text-right">Remaining</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {fulfillment.entries.map((e) => (
                                <tr key={e.entryGuid} className="hover:bg-surface-hover/50 transition-colors">
                                    <td className="px-4 py-2 text-foreground-secondary max-w-sm truncate">
                                        {entryInfo.get(e.entryGuid)?.description || <span className="text-foreground-muted">—</span>}
                                    </td>
                                    <td className="px-4 py-2 font-mono tabular-nums text-right text-foreground-secondary" style={TNUM}>
                                        {formatQty(e.invoicedQuantity)}
                                    </td>
                                    <td className="px-4 py-2 font-mono tabular-nums text-right text-foreground-secondary" style={TNUM}>
                                        {formatQty(e.fulfilledQuantity)}
                                    </td>
                                    <td
                                        className={`px-4 py-2 font-mono tabular-nums text-right ${
                                            e.remainingQuantity > 0 ? 'text-warning' : 'text-positive'
                                        }`}
                                        style={TNUM}
                                    >
                                        {formatQty(e.remainingQuantity)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {fulfillment && (
                <AllocationModal
                    mode={mode}
                    invoiceGuid={invoiceGuid}
                    fulfillment={fulfillment}
                    entryInfo={entryInfo}
                    items={items}
                    locations={locations}
                    onClose={() => setMode(null)}
                    onDone={fetchFulfillment}
                />
            )}
        </div>
    );
}
