'use client';

import { useCallback, useEffect, useState, Fragment } from 'react';
import type { HomeRoom, HomeItem } from '@/lib/services/home.service';
import { formatCurrency } from '@/lib/format';
import { useToast } from '@/contexts/ToastContext';
import {
    CATEGORY_OPTIONS,
    categoryLabel,
    inputClass,
    isDraftItem,
    itemDisplayName,
    labelClass,
    TNUM,
    WarrantyBadge,
} from './home-shared';

interface ReceiptOption {
    id: number;
    filename: string;
}

interface ItemFormState {
    roomId: number;
    name: string;
    category: string;
    estValue: string;
    purchaseDate: string;
    warrantyExpires: string;
    serial: string;
    notes: string;
    receiptId: string; // '' = none
}

function emptyForm(roomId: number): ItemFormState {
    return {
        roomId,
        name: '',
        category: '',
        estValue: '',
        purchaseDate: '',
        warrantyExpires: '',
        serial: '',
        notes: '',
        receiptId: '',
    };
}

function formFromItem(item: HomeItem): ItemFormState {
    return {
        roomId: item.roomId,
        name: item.name,
        category: item.category ?? '',
        estValue: item.estValue !== null ? String(item.estValue) : '',
        purchaseDate: item.purchaseDate ?? '',
        warrantyExpires: item.warrantyExpires ?? '',
        serial: item.serial ?? '',
        notes: item.notes ?? '',
        receiptId: item.receiptId !== null ? String(item.receiptId) : '',
    };
}

function formToBody(form: ItemFormState): Record<string, unknown> {
    return {
        roomId: form.roomId,
        name: form.name.trim(),
        category: form.category || null,
        estValue: form.estValue === '' ? null : Number(form.estValue),
        purchaseDate: form.purchaseDate || null,
        warrantyExpires: form.warrantyExpires || null,
        serial: form.serial || null,
        notes: form.notes || null,
        receiptId: form.receiptId === '' ? null : Number(form.receiptId),
    };
}

interface RoomDetailPanelProps {
    room: HomeRoom;
    rooms: HomeRoom[];
    onBack: () => void;
    /** Items/room changed — parent should refresh the summary. */
    onChanged: () => void;
    onRoomDeleted: () => void;
}

/**
 * One room's item list: inline edit with warranty badges, move-item-to-room,
 * optional receipt link, and photo upload/remove.
 */
export function RoomDetailPanel({
    room,
    rooms,
    onBack,
    onChanged,
    onRoomDeleted,
}: RoomDetailPanelProps) {
    const toast = useToast();
    const [items, setItems] = useState<HomeItem[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const [renaming, setRenaming] = useState(false);
    const [roomName, setRoomName] = useState(room.name);
    const [confirmDeleteRoom, setConfirmDeleteRoom] = useState(false);

    const [addOpen, setAddOpen] = useState(false);
    const [addForm, setAddForm] = useState<ItemFormState>(emptyForm(room.id));
    const [addPhotos, setAddPhotos] = useState<File[]>([]);

    const [editingId, setEditingId] = useState<number | null>(null);
    const [editForm, setEditForm] = useState<ItemFormState | null>(null);
    const [editPhotos, setEditPhotos] = useState<File[]>([]);
    const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
    const [saving, setSaving] = useState(false);

    const [receipts, setReceipts] = useState<ReceiptOption[] | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/home/items?roomId=${room.id}`);
            if (!res.ok) throw new Error(`Request failed (${res.status})`);
            const json = (await res.json()) as { items: HomeItem[] };
            setItems(json.items);
            setError(null);
        } catch {
            setError('Failed to load items.');
        }
    }, [room.id]);

    useEffect(() => {
        void load();
    }, [load]);

    // Receipt options load lazily, once, when a form first opens.
    const needReceipts = addOpen || editingId !== null;
    useEffect(() => {
        if (!needReceipts || receipts !== null) return;
        let cancelled = false;
        fetch('/api/receipts?limit=100')
            .then((res) => (res.ok ? res.json() : null))
            .then((json) => {
                if (cancelled) return;
                const list = (json?.receipts ?? []) as Array<{ id: number; filename: string }>;
                setReceipts(list.map((r) => ({ id: r.id, filename: r.filename })));
            })
            .catch(() => {
                if (!cancelled) setReceipts([]);
            });
        return () => {
            cancelled = true;
        };
    }, [needReceipts, receipts]);

    /** Upload photos one at a time so a single bad file doesn't drop the rest. */
    const uploadPhotos = async (itemId: number, files: File[]) => {
        for (const file of files) {
            const formData = new FormData();
            formData.append('file', file);
            const res = await fetch(`/api/home/items/${itemId}/photos`, {
                method: 'POST',
                body: formData,
            });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                toast.error(json?.error ?? `"${file.name}" failed to upload`);
            }
        }
    };

    const handleRenameRoom = async () => {
        const name = roomName.trim();
        if (!name || name === room.name) {
            setRenaming(false);
            setRoomName(room.name);
            return;
        }
        try {
            const res = await fetch(`/api/home/rooms/${room.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                throw new Error(json?.error ?? 'Rename failed');
            }
            setRenaming(false);
            onChanged();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to rename room');
        }
    };

    const handleDeleteRoom = async () => {
        try {
            const res = await fetch(`/api/home/rooms/${room.id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Delete failed');
            toast.success('Room deleted');
            onRoomDeleted();
        } catch {
            toast.error('Failed to delete room');
        }
    };

    const handleAdd = async () => {
        if (!addForm.name.trim()) {
            toast.error('Item name is required');
            return;
        }
        setSaving(true);
        try {
            const res = await fetch('/api/home/items', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formToBody(addForm)),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                throw new Error(json?.error ?? 'Failed to add item');
            }
            const { item } = (await res.json()) as { item: HomeItem };
            if (addPhotos.length > 0) await uploadPhotos(item.id, addPhotos);
            toast.success('Item added');
            setAddForm(emptyForm(room.id));
            setAddPhotos([]);
            await load();
            onChanged();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to add item');
        } finally {
            setSaving(false);
        }
    };

    const handleSaveEdit = async (item: HomeItem) => {
        if (!editForm) return;
        if (!editForm.name.trim()) {
            toast.error('Item name is required');
            return;
        }
        setSaving(true);
        try {
            const res = await fetch(`/api/home/items/${item.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formToBody(editForm)),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                throw new Error(json?.error ?? 'Save failed');
            }
            if (editPhotos.length > 0) await uploadPhotos(item.id, editPhotos);
            const moved = editForm.roomId !== room.id;
            toast.success(moved ? 'Item moved' : 'Item updated');
            setEditingId(null);
            setEditForm(null);
            setEditPhotos([]);
            await load();
            onChanged();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to update item');
        } finally {
            setSaving(false);
        }
    };

    const handleRemovePhoto = async (itemId: number, photoId: number) => {
        try {
            const res = await fetch(`/api/home/items/${itemId}/photos/${photoId}`, {
                method: 'DELETE',
            });
            if (!res.ok) throw new Error('Failed');
            toast.success('Photo removed');
            await load();
        } catch {
            toast.error('Failed to remove photo');
        }
    };

    const handleDeleteItem = async (id: number) => {
        try {
            const res = await fetch(`/api/home/items/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Delete failed');
            toast.success('Item deleted');
            setConfirmDeleteId(null);
            await load();
            onChanged();
        } catch {
            toast.error('Failed to delete item');
        }
    };

    const totalValue = (items ?? []).reduce((sum, i) => sum + (i.estValue ?? 0), 0);

    const renderFormFields = (
        form: ItemFormState,
        setForm: (f: ItemFormState) => void,
        newPhotos: File[],
        setNewPhotos: (f: File[]) => void,
        options: {
            showMoveRoom: boolean;
            /** Existing item, when editing — enables the saved-photo gallery. */
            item?: HomeItem;
        },
    ) => (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="sm:col-span-2">
                <label className={labelClass}>Name *</label>
                <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className={inputClass}
                />
            </div>
            <div>
                <label className={labelClass}>Category</label>
                <select
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
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
                    onChange={(e) => setForm({ ...form, estValue: e.target.value })}
                    className={`${inputClass} font-mono`}
                    style={TNUM}
                />
            </div>
            <div>
                <label className={labelClass}>Purchased</label>
                <input
                    type="date"
                    value={form.purchaseDate}
                    onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })}
                    className={`${inputClass} font-mono`}
                />
            </div>
            <div>
                <label className={labelClass}>Warranty until</label>
                <input
                    type="date"
                    value={form.warrantyExpires}
                    onChange={(e) => setForm({ ...form, warrantyExpires: e.target.value })}
                    className={`${inputClass} font-mono`}
                />
            </div>
            <div>
                <label className={labelClass}>Serial #</label>
                <input
                    type="text"
                    value={form.serial}
                    onChange={(e) => setForm({ ...form, serial: e.target.value })}
                    className={`${inputClass} font-mono`}
                />
            </div>
            <div>
                <label className={labelClass}>Receipt (optional)</label>
                <select
                    value={form.receiptId}
                    onChange={(e) => setForm({ ...form, receiptId: e.target.value })}
                    className={inputClass}
                >
                    <option value="">None</option>
                    {(receipts ?? []).map((r) => (
                        <option key={r.id} value={String(r.id)}>
                            {r.filename}
                        </option>
                    ))}
                </select>
            </div>
            {options.showMoveRoom && (
                <div>
                    <label className={labelClass}>Room</label>
                    <select
                        value={String(form.roomId)}
                        onChange={(e) => setForm({ ...form, roomId: Number(e.target.value) })}
                        className={inputClass}
                    >
                        {rooms.map((r) => (
                            <option key={r.id} value={String(r.id)}>
                                {r.name}
                            </option>
                        ))}
                    </select>
                </div>
            )}
            <div className={options.showMoveRoom ? 'sm:col-span-2' : 'sm:col-span-2 lg:col-span-3'}>
                <label className={labelClass}>Notes</label>
                <input
                    type="text"
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    className={inputClass}
                />
            </div>
            <div className="sm:col-span-2 lg:col-span-4">
                <label className={labelClass}>Photos</label>
                {options.item && options.item.photos.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2">
                        {options.item.photos.map((p) => (
                            <div key={p.id} className="relative">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                    src={`/api/home/items/${options.item!.id}/photos/${p.id}`}
                                    alt=""
                                    className="h-16 w-16 rounded-md border border-border object-cover"
                                />
                                <button
                                    type="button"
                                    onClick={() => handleRemovePhoto(options.item!.id, p.id)}
                                    aria-label="Remove photo"
                                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-foreground-muted hover:text-error hover:border-error transition-colors"
                                >
                                    ×
                                </button>
                            </div>
                        ))}
                    </div>
                )}
                <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    multiple
                    onChange={(e) => setNewPhotos(Array.from(e.target.files ?? []))}
                    className="block w-full text-sm text-foreground-secondary file:mr-3 file:rounded-lg file:border file:border-border file:bg-background-tertiary file:px-3 file:py-1 file:text-xs file:text-foreground-secondary hover:file:border-border-hover file:transition-colors"
                />
                {newPhotos.length > 0 && (
                    <p className="mt-1 text-xs text-foreground-muted">
                        {newPhotos.length} new photo{newPhotos.length === 1 ? '' : 's'} to upload
                    </p>
                )}
            </div>
        </div>
    );

    return (
        <div className="space-y-4">
            {/* Room header */}
            <div className="flex flex-wrap items-center gap-3">
                <button
                    type="button"
                    onClick={onBack}
                    className="text-sm text-foreground-secondary hover:text-foreground transition-colors"
                >
                    ← All rooms
                </button>
                {renaming ? (
                    <span className="flex items-center gap-2">
                        <input
                            type="text"
                            value={roomName}
                            onChange={(e) => setRoomName(e.target.value)}
                            className={`${inputClass} w-56`}
                            autoFocus
                        />
                        <button
                            type="button"
                            onClick={handleRenameRoom}
                            className="text-sm text-primary hover:text-primary-hover transition-colors"
                        >
                            Save
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setRenaming(false);
                                setRoomName(room.name);
                            }}
                            className="text-sm text-foreground-muted hover:text-foreground transition-colors"
                        >
                            Cancel
                        </button>
                    </span>
                ) : (
                    <h2 className="text-lg font-bold text-foreground">{room.name}</h2>
                )}
                <span className="text-sm text-foreground-secondary">
                    <span className="font-mono" style={TNUM}>{items?.length ?? 0}</span> item
                    {(items?.length ?? 0) === 1 ? '' : 's'} ·{' '}
                    <span className="font-mono" style={TNUM}>{formatCurrency(totalValue)}</span>
                </span>
                <span className="ml-auto flex items-center gap-3 text-sm">
                    {!renaming && (
                        <button
                            type="button"
                            onClick={() => setRenaming(true)}
                            className="text-foreground-secondary hover:text-foreground transition-colors"
                        >
                            Rename
                        </button>
                    )}
                    {confirmDeleteRoom ? (
                        <span className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={handleDeleteRoom}
                                className="font-medium text-error hover:opacity-80 transition-opacity"
                            >
                                Confirm delete room + items
                            </button>
                            <button
                                type="button"
                                onClick={() => setConfirmDeleteRoom(false)}
                                className="text-foreground-muted hover:text-foreground transition-colors"
                            >
                                Cancel
                            </button>
                        </span>
                    ) : (
                        <button
                            type="button"
                            onClick={() => setConfirmDeleteRoom(true)}
                            className="text-foreground-muted hover:text-error transition-colors"
                        >
                            Delete room
                        </button>
                    )}
                </span>
            </div>

            {error && (
                <div className="border border-error/30 bg-surface/30 rounded-xl p-4">
                    <p className="text-sm text-error">{error}</p>
                </div>
            )}

            {/* Add item */}
            <div className="bg-background-secondary/30 border border-border rounded-xl p-4 space-y-3">
                {addOpen ? (
                    <>
                        {renderFormFields(addForm, setAddForm, addPhotos, setAddPhotos, {
                            showMoveRoom: false,
                        })}
                        <div className="flex items-center gap-3">
                            <button
                                type="button"
                                onClick={handleAdd}
                                disabled={saving}
                                className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover transition-colors disabled:opacity-50"
                            >
                                {saving ? 'Saving…' : 'Add item'}
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setAddOpen(false);
                                    setAddForm(emptyForm(room.id));
                                    setAddPhotos([]);
                                }}
                                className="rounded-lg border border-border px-4 py-1.5 text-sm text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    </>
                ) : (
                    <button
                        type="button"
                        onClick={() => setAddOpen(true)}
                        className="text-sm text-primary hover:text-primary-hover transition-colors"
                    >
                        + Add item to {room.name}
                    </button>
                )}
            </div>

            {/* Item list */}
            {items !== null && items.length === 0 ? (
                <div className="bg-background-secondary/30 border border-border rounded-xl p-8 text-center">
                    <p className="text-sm text-foreground-secondary">
                        No items in this room yet — add one above, or run the walk-through.
                    </p>
                </div>
            ) : (
                items !== null && (
                    <div className="bg-background-secondary/30 border border-border rounded-xl overflow-hidden">
                        <ul>
                            {items.map((item) => (
                                <Fragment key={item.id}>
                                    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/30 px-4 py-2.5 last:border-b-0">
                                        {item.photos.length > 0 && (
                                            <div className="relative shrink-0">
                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                <img
                                                    src={`/api/home/items/${item.id}/photos/${item.photos[0].id}`}
                                                    alt={item.name}
                                                    className="h-9 w-9 rounded-md border border-border object-cover"
                                                />
                                                {item.photos.length > 1 && (
                                                    <span className="absolute -bottom-1 -right-1 rounded-full border border-border bg-background px-1 text-[10px] font-medium text-foreground-secondary">
                                                        {item.photos.length}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                        <div className="min-w-0 flex-1">
                                            <span
                                                className={`text-sm ${
                                                    isDraftItem(item.name)
                                                        ? 'italic text-foreground-muted'
                                                        : 'text-foreground'
                                                }`}
                                            >
                                                {isDraftItem(item.name)
                                                    ? 'Untitled — needs details'
                                                    : itemDisplayName(item.name)}
                                            </span>
                                            <span className="ml-3 text-xs text-foreground-muted">
                                                {[
                                                    categoryLabel(item.category),
                                                    item.serial ? `SN ${item.serial}` : null,
                                                    item.purchaseDate
                                                        ? `bought ${item.purchaseDate}`
                                                        : null,
                                                    item.receiptId !== null ? 'receipt linked' : null,
                                                ]
                                                    .filter(Boolean)
                                                    .join(' · ')}
                                            </span>
                                            {item.notes && (
                                                <p className="mt-0.5 truncate text-xs text-foreground-muted">
                                                    {item.notes}
                                                </p>
                                            )}
                                        </div>
                                        <WarrantyBadge
                                            warrantyExpires={item.warrantyExpires}
                                            warrantyDays={item.warrantyDays}
                                        />
                                        <span className="font-mono text-sm text-foreground-secondary" style={TNUM}>
                                            {item.estValue !== null ? formatCurrency(item.estValue) : '—'}
                                        </span>
                                        <div className="flex items-center gap-3 text-sm">
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    if (editingId === item.id) {
                                                        setEditingId(null);
                                                        setEditForm(null);
                                                        setEditPhotos([]);
                                                    } else {
                                                        setEditingId(item.id);
                                                        setEditForm(formFromItem(item));
                                                        setEditPhotos([]);
                                                        setConfirmDeleteId(null);
                                                    }
                                                }}
                                                className="text-foreground-secondary hover:text-foreground transition-colors"
                                            >
                                                Edit
                                            </button>
                                            {confirmDeleteId === item.id ? (
                                                <span className="flex items-center gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => handleDeleteItem(item.id)}
                                                        className="font-medium text-error hover:opacity-80 transition-opacity"
                                                    >
                                                        Confirm
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => setConfirmDeleteId(null)}
                                                        className="text-foreground-muted hover:text-foreground transition-colors"
                                                    >
                                                        Cancel
                                                    </button>
                                                </span>
                                            ) : (
                                                <button
                                                    type="button"
                                                    onClick={() => setConfirmDeleteId(item.id)}
                                                    className="text-foreground-muted hover:text-error transition-colors"
                                                >
                                                    Delete
                                                </button>
                                            )}
                                        </div>
                                    </li>
                                    {editingId === item.id && editForm && (
                                        <li className="border-b border-border/30 bg-background-tertiary/30 px-4 py-3 last:border-b-0">
                                            {renderFormFields(editForm, setEditForm, editPhotos, setEditPhotos, {
                                                showMoveRoom: true,
                                                item,
                                            })}
                                            <div className="mt-3 flex flex-wrap items-center gap-3">
                                                <button
                                                    type="button"
                                                    onClick={() => handleSaveEdit(item)}
                                                    disabled={saving}
                                                    className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover transition-colors disabled:opacity-50"
                                                >
                                                    {saving ? 'Saving…' : 'Save'}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setEditingId(null);
                                                        setEditForm(null);
                                                        setEditPhotos([]);
                                                    }}
                                                    className="rounded-lg border border-border px-4 py-1.5 text-sm text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors"
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        </li>
                                    )}
                                </Fragment>
                            ))}
                        </ul>
                    </div>
                )
            )}
        </div>
    );
}
