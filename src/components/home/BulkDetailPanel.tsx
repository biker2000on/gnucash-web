'use client';

import { useCallback, useEffect, useState } from 'react';
import type { HomeRoom, HomeItem } from '@/lib/services/home.service';
import { useToast } from '@/contexts/ToastContext';
import { CATEGORY_OPTIONS, inputClass, labelClass, TNUM } from './home-shared';

interface BulkDetailPanelProps {
    rooms: HomeRoom[];
    onBack: () => void;
    /** Called after any save/delete so the parent can refresh its summary. */
    onChanged: () => void;
}

/**
 * Desktop bulk-detailing for photos-first drafts: every un-named item across the
 * book, grouped by room, each shown with its photos and a compact inline form.
 * Naming an item removes it from the list; the count drives the parent banner.
 */
export function BulkDetailPanel({ rooms, onBack, onChanged }: BulkDetailPanelProps) {
    const [drafts, setDrafts] = useState<HomeItem[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/home/items?draft=1');
            if (!res.ok) throw new Error(`Request failed (${res.status})`);
            const json = (await res.json()) as { items: HomeItem[] };
            setDrafts(json.items);
            setError(null);
        } catch {
            setError('Failed to load items awaiting details.');
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const roomName = (id: number) => rooms.find((r) => r.id === id)?.name ?? 'Room';

    // Drop a card from the local list once it's named or deleted, and tell the parent.
    const handleResolved = (itemId: number) => {
        setDrafts((prev) => (prev ? prev.filter((d) => d.id !== itemId) : prev));
        onChanged();
    };

    // Group drafts by room, preserving the room sort order from the query.
    const byRoom: Array<{ roomId: number; items: HomeItem[] }> = [];
    for (const item of drafts ?? []) {
        const bucket = byRoom.find((b) => b.roomId === item.roomId);
        if (bucket) bucket.items.push(item);
        else byRoom.push({ roomId: item.roomId, items: [item] });
    }

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <button
                    type="button"
                    onClick={onBack}
                    className="text-sm text-foreground-secondary hover:text-foreground transition-colors"
                >
                    ← All rooms
                </button>
                <h2 className="text-lg font-bold text-foreground">Add details to captured items</h2>
                {drafts !== null && (
                    <span className="text-sm text-foreground-secondary">
                        <span className="font-mono" style={TNUM}>{drafts.length}</span> awaiting details
                    </span>
                )}
            </div>

            {error && (
                <div className="border border-error/30 bg-surface/30 rounded-xl p-4">
                    <p className="text-sm text-error">{error}</p>
                </div>
            )}

            {drafts !== null && drafts.length === 0 && !error && (
                <div className="bg-background-secondary/30 border border-border rounded-xl p-8 text-center">
                    <p className="text-sm text-foreground-secondary">
                        Nothing left to detail — every captured item has a name. Nice work.
                    </p>
                </div>
            )}

            {byRoom.map(({ roomId, items }) => (
                <div key={roomId} className="space-y-3">
                    <p className="text-[10px] font-medium uppercase tracking-wider text-foreground-muted">
                        {roomName(roomId)}
                        <span className="ml-2 font-mono" style={TNUM}>{items.length}</span>
                    </p>
                    {items.map((item) => (
                        <DraftCard
                            key={item.id}
                            item={item}
                            rooms={rooms}
                            onResolved={() => handleResolved(item.id)}
                        />
                    ))}
                </div>
            ))}
        </div>
    );
}

interface DraftCardState {
    name: string;
    category: string;
    estValue: string;
    purchaseDate: string;
    warrantyExpires: string;
    serial: string;
    roomId: number;
}

function DraftCard({
    item,
    rooms,
    onResolved,
}: {
    item: HomeItem;
    rooms: HomeRoom[];
    onResolved: () => void;
}) {
    const toast = useToast();
    const [form, setForm] = useState<DraftCardState>({
        name: '',
        category: item.category ?? '',
        estValue: item.estValue !== null ? String(item.estValue) : '',
        purchaseDate: item.purchaseDate ?? '',
        warrantyExpires: item.warrantyExpires ?? '',
        serial: item.serial ?? '',
        roomId: item.roomId,
    });
    const [saving, setSaving] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);

    const set = <K extends keyof DraftCardState>(key: K, value: DraftCardState[K]) =>
        setForm((f) => ({ ...f, [key]: value }));

    const handleSave = async () => {
        if (!form.name.trim()) {
            toast.error('Give the item a name to file it');
            return;
        }
        setSaving(true);
        try {
            const res = await fetch(`/api/home/items/${item.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    roomId: form.roomId,
                    name: form.name.trim(),
                    category: form.category || null,
                    estValue: form.estValue === '' ? null : Number(form.estValue),
                    purchaseDate: form.purchaseDate || null,
                    warrantyExpires: form.warrantyExpires || null,
                    serial: form.serial || null,
                }),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                throw new Error(json?.error ?? 'Save failed');
            }
            toast.success('Item filed');
            onResolved();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to save item');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        setSaving(true);
        try {
            const res = await fetch(`/api/home/items/${item.id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Delete failed');
            toast.success('Item deleted');
            onResolved();
        } catch {
            toast.error('Failed to delete item');
            setSaving(false);
        }
    };

    return (
        <div className="bg-background-secondary/30 border border-border rounded-xl p-4">
            <div className="flex flex-col gap-4 sm:flex-row">
                {/* Photo strip */}
                <div className="flex shrink-0 flex-wrap gap-2 sm:w-40">
                    {item.photos.length === 0 ? (
                        <div className="flex h-20 w-20 items-center justify-center rounded-md border border-dashed border-border text-[10px] text-foreground-muted">
                            no photo
                        </div>
                    ) : (
                        item.photos.map((p) => (
                            <a
                                key={p.id}
                                href={`/api/home/items/${item.id}/photos/${p.id}`}
                                target="_blank"
                                rel="noreferrer"
                                className="block"
                            >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                    src={`/api/home/items/${item.id}/photos/${p.id}`}
                                    alt=""
                                    className="h-20 w-20 rounded-md border border-border object-cover transition-opacity hover:opacity-80"
                                />
                            </a>
                        ))
                    )}
                </div>

                {/* Fields */}
                <div className="min-w-0 flex-1">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        <div className="sm:col-span-2 lg:col-span-1">
                            <label className={labelClass}>Name *</label>
                            <input
                                type="text"
                                value={form.name}
                                onChange={(e) => set('name', e.target.value)}
                                placeholder="What is it?"
                                className={inputClass}
                                autoFocus
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Category</label>
                            <select
                                value={form.category}
                                onChange={(e) => set('category', e.target.value)}
                                className={inputClass}
                            >
                                <option value="">—</option>
                                {CATEGORY_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>
                                        {o.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className={labelClass}>Est. value</label>
                            <input
                                type="number"
                                min="0"
                                step="0.01"
                                inputMode="decimal"
                                value={form.estValue}
                                onChange={(e) => set('estValue', e.target.value)}
                                placeholder="0.00"
                                className={`${inputClass} font-mono`}
                                style={TNUM}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Purchased</label>
                            <input
                                type="date"
                                value={form.purchaseDate}
                                onChange={(e) => set('purchaseDate', e.target.value)}
                                className={`${inputClass} font-mono`}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Warranty until</label>
                            <input
                                type="date"
                                value={form.warrantyExpires}
                                onChange={(e) => set('warrantyExpires', e.target.value)}
                                className={`${inputClass} font-mono`}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Serial #</label>
                            <input
                                type="text"
                                value={form.serial}
                                onChange={(e) => set('serial', e.target.value)}
                                className={`${inputClass} font-mono`}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Room</label>
                            <select
                                value={String(form.roomId)}
                                onChange={(e) => set('roomId', Number(e.target.value))}
                                className={inputClass}
                            >
                                {rooms.map((r) => (
                                    <option key={r.id} value={String(r.id)}>
                                        {r.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-3">
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={saving}
                            className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover transition-colors disabled:opacity-50"
                        >
                            {saving ? 'Saving…' : 'Save & file'}
                        </button>
                        {confirmDelete ? (
                            <span className="flex items-center gap-2 text-sm">
                                <button
                                    type="button"
                                    onClick={handleDelete}
                                    disabled={saving}
                                    className="font-medium text-error hover:opacity-80 transition-opacity disabled:opacity-50"
                                >
                                    Confirm delete
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setConfirmDelete(false)}
                                    className="text-foreground-muted hover:text-foreground transition-colors"
                                >
                                    Cancel
                                </button>
                            </span>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setConfirmDelete(true)}
                                className="text-sm text-foreground-muted hover:text-error transition-colors"
                            >
                                Delete
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
