'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ItemSelector } from '@/components/business/ItemSelector';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import { formatCurrency } from '@/lib/format';
import {
    type BillReceivingDTO,
    type BillReceivingEntryDTO,
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

export interface ReceivingEntryInfo {
    guid: string;
    description: string;
    quantity: number;
}

interface BillReceivingSectionProps {
    billGuid: string;
    /** Bill entries (guid, description, quantity) for row labels. */
    entries: ReceivingEntryInfo[];
}

interface ReceiveDraft {
    entryGuid: string;
    description: string;
    /** Remaining (receivable) quantity for this entry. */
    max: number;
    /** The bill entry's unit price — the receive cost basis. */
    unitCost: number;
    itemId: number | null;
    quantity: string;
    locationId: string;
}

function ReceiveModal({
    open,
    billGuid,
    receiving,
    entryInfo,
    items,
    locations,
    onClose,
    onDone,
}: {
    open: boolean;
    billGuid: string;
    receiving: BillReceivingDTO;
    entryInfo: Map<string, ReceivingEntryInfo>;
    items: ItemDTO[];
    locations: LocationDTO[];
    onClose: () => void;
    onDone: () => void;
}) {
    const { success, error } = useToast();
    const [rows, setRows] = useState<ReceiveDraft[]>([]);
    const [date, setDate] = useState(todayIso());
    const [busy, setBusy] = useState(false);

    const activeLocations = useMemo(() => locations.filter((l) => l.active), [locations]);

    useEffect(() => {
        if (!open) return;
        const defaultLocation = activeLocations.length === 1 ? String(activeLocations[0].id) : '';
        const eligible = receiving.entries.filter((e: BillReceivingEntryDTO) => e.remainingQuantity > 0);
        setRows(eligible.map((e) => ({
            entryGuid: e.entryGuid,
            description: entryInfo.get(e.entryGuid)?.description || '(no description)',
            max: e.remainingQuantity,
            unitCost: e.unitCost,
            itemId: defaultItemIdForEntry(e),
            quantity: String(e.remainingQuantity),
            locationId: defaultLocation,
        })));
        setDate(todayIso());
    }, [open, receiving, entryInfo, activeLocations]);

    if (!open) return null;

    const updateRow = (entryGuid: string, patch: Partial<ReceiveDraft>) => {
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
                error(`"${row.description}" exceeds the remaining quantity (${formatQty(row.max)})`);
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
            const res = await fetch(`/api/inventory/bills/${billGuid}/receiving`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ allocations, date }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to receive');
            success('Stock received against bill');
            onClose();
            onDone();
        } catch (err) {
            // 400 (over-receive) and 409 (unposted bill) arrive here with the
            // API's message.
            error(err instanceof Error ? err.message : 'Operation failed');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal isOpen onClose={busy ? () => {} : onClose} title="Receive against Bill" size="xl">
            <form onSubmit={handleSubmit} className="px-6 py-4 space-y-3">
                <p className="text-sm text-foreground-secondary">
                    Receive inventory against this bill. Pick the item each line refers to — bill
                    lines carry no item link. Each receipt uses the line&apos;s unit price as the cost
                    basis. Leave a quantity blank to skip a line.
                </p>
                <p className="text-xs text-foreground-muted">
                    No ledger transaction is written — posting the bill already booked the debit.
                    For inventory purchases, use the item&apos;s Inventory asset account on the bill line
                    so the posting debits inventory directly.
                </p>

                {activeLocations.length === 0 && (
                    <p className="text-sm text-warning">No active inventory locations — create one first.</p>
                )}

                <div className="border border-border rounded-lg overflow-x-auto">
                    <table className="w-full text-left text-[13px]">
                        <thead>
                            <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                <th className="px-3 py-2 font-semibold min-w-40">Bill line</th>
                                <th className="px-3 py-2 font-semibold min-w-52">Item</th>
                                <th className="px-3 py-2 font-semibold text-right w-28">
                                    Qty <span className="normal-case">(max remaining)</span>
                                </th>
                                <th className="px-3 py-2 font-semibold text-right w-24">Unit cost</th>
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
                                    <td className="px-3 py-2 font-mono tabular-nums text-right text-foreground-secondary whitespace-nowrap" style={TNUM}>
                                        {formatCurrency(row.unitCost)}
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
                        {busy ? 'Working...' : 'Receive'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

/**
 * Receiving panel for a POSTED vendor bill: per-entry billed / received /
 * remaining quantities plus a Receive flow backed by
 * /api/inventory/bills/[guid]/receiving. Mirrors InvoiceFulfillmentSection;
 * renders nothing until the receiving view loads and stays out of the way of
 * the existing bill behavior.
 */
export function BillReceivingSection({ billGuid, entries }: BillReceivingSectionProps) {
    const { isReadonly } = useCurrentUser();
    const [receiving, setReceiving] = useState<BillReceivingDTO | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [items, setItems] = useState<ItemDTO[]>([]);
    const [locations, setLocations] = useState<LocationDTO[]>([]);
    const [receiveOpen, setReceiveOpen] = useState(false);

    const fetchReceiving = useCallback(async () => {
        try {
            const res = await fetch(`/api/inventory/bills/${billGuid}/receiving`);
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to load receiving');
            setReceiving(data.receiving);
            setLoadError(null);
        } catch (err) {
            setLoadError(err instanceof Error ? err.message : 'Failed to load receiving');
        } finally {
            setLoading(false);
        }
    }, [billGuid]);

    useEffect(() => { fetchReceiving(); }, [fetchReceiving]);

    // Reference data for the receive modal (best-effort).
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

    const canReceive = receiving?.entries.some((e) => e.remainingQuantity > 0) ?? false;

    return (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold text-foreground">Receiving</h2>
                    {receiving?.fullyReceived && (
                        <span className="inline-block px-2 py-0.5 text-xs rounded-md bg-positive/10 text-positive">
                            Fully received
                        </span>
                    )}
                </div>
                {receiving && (
                    <button
                        type="button"
                        onClick={() => setReceiveOpen(true)}
                        disabled={isReadonly || !canReceive}
                        title={isReadonly ? READONLY_TOOLTIP : !canReceive ? 'All lines are fully received' : undefined}
                        className="px-2.5 py-1 text-xs rounded-md bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground transition-colors"
                    >
                        Receive...
                    </button>
                )}
            </div>

            {loadError ? (
                <p className="px-4 py-4 text-sm text-foreground-muted">{loadError}</p>
            ) : !receiving || receiving.entries.length === 0 ? (
                <p className="px-4 py-4 text-sm text-foreground-muted">No receivable lines on this bill.</p>
            ) : (
                <>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-[13px]">
                            <thead>
                                <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                    <th className="px-4 py-2 font-semibold">Line</th>
                                    <th className="px-4 py-2 font-semibold text-right">Unit cost</th>
                                    <th className="px-4 py-2 font-semibold text-right">Billed</th>
                                    <th className="px-4 py-2 font-semibold text-right">Received</th>
                                    <th className="px-4 py-2 font-semibold text-right">Remaining</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {receiving.entries.map((e) => (
                                    <tr key={e.entryGuid} className="hover:bg-surface-hover/50 transition-colors">
                                        <td className="px-4 py-2 text-foreground-secondary max-w-sm truncate">
                                            {entryInfo.get(e.entryGuid)?.description || <span className="text-foreground-muted">—</span>}
                                        </td>
                                        <td className="px-4 py-2 font-mono tabular-nums text-right text-foreground-secondary" style={TNUM}>
                                            {formatCurrency(e.unitCost)}
                                        </td>
                                        <td className="px-4 py-2 font-mono tabular-nums text-right text-foreground-secondary" style={TNUM}>
                                            {formatQty(e.billedQuantity)}
                                        </td>
                                        <td className="px-4 py-2 font-mono tabular-nums text-right text-foreground-secondary" style={TNUM}>
                                            {formatQty(e.receivedQuantity)}
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
                    <p className="px-4 py-2 border-t border-border text-xs text-foreground-muted">
                        Receiving records stock only — the posted bill already booked the debit. Use
                        the item&apos;s Inventory asset account on bill lines for inventory purchases.
                    </p>
                </>
            )}

            {receiving && (
                <ReceiveModal
                    open={receiveOpen}
                    billGuid={billGuid}
                    receiving={receiving}
                    entryInfo={entryInfo}
                    items={items}
                    locations={locations}
                    onClose={() => setReceiveOpen(false)}
                    onDone={fetchReceiving}
                />
            )}
        </div>
    );
}
