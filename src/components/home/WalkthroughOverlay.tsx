'use client';

import { useEffect, useRef, useState } from 'react';
import type { HomeRoom, HomeItem } from '@/lib/services/home.service';
import { formatCurrency } from '@/lib/format';
import { useToast } from '@/contexts/ToastContext';
import { CATEGORY_OPTIONS, inputClass, labelClass, TNUM } from './home-shared';

/** Capture mode: fill in details now, or snap photos now and detail later. */
type WalkMode = 'detail' | 'photos';
const MODE_KEY = 'home-walkthrough-mode';

function initialMode(): WalkMode {
    if (typeof window === 'undefined') return 'photos';
    return window.localStorage.getItem(MODE_KEY) === 'detail' ? 'detail' : 'photos';
}

interface AddedItem {
    id: number;
    name: string;
    estValue: number | null;
    roomId: number;
    photoCount: number;
}

interface WalkthroughOverlayProps {
    rooms: HomeRoom[];
    /** Called when the walk-through closes; `changed` = at least one item added. */
    onClose: (changed: boolean) => void;
}

/**
 * Full-screen room-by-room capture stepper with two modes:
 *  - "Detail each" — the rapid-entry form (name/category/value/photos per item).
 *  - "Photos only" — snap photos per item now, leave them as un-named drafts,
 *    and fill in the details later in bulk on the desktop.
 * "Add item" keeps you in the room; Previous/Next room navigate; "Finish"
 * shows a recap.
 */
export function WalkthroughOverlay({ rooms, onClose }: WalkthroughOverlayProps) {
    const toast = useToast();
    const [mode, setMode] = useState<WalkMode>(initialMode);
    const [roomIndex, setRoomIndex] = useState(0);
    const [added, setAdded] = useState<AddedItem[]>([]);
    const [finished, setFinished] = useState(false);
    const [saving, setSaving] = useState(false);

    // Rapid-entry form (detail mode)
    const [name, setName] = useState('');
    const [category, setCategory] = useState('');
    const [estValue, setEstValue] = useState('');
    const [warranty, setWarranty] = useState('');
    const [serial, setSerial] = useState('');
    const [photos, setPhotos] = useState<File[]>([]);
    const nameRef = useRef<HTMLInputElement>(null);
    const photoRef = useRef<HTMLInputElement>(null);

    const room = rooms[roomIndex];
    const isFirstRoom = roomIndex === 0;
    const isLastRoom = roomIndex === rooms.length - 1;
    const roomAdded = added.filter((a) => a.roomId === room?.id);
    const totalValue = added.reduce((sum, a) => sum + (a.estValue ?? 0), 0);

    const chooseMode = (next: WalkMode) => {
        setMode(next);
        if (typeof window !== 'undefined') window.localStorage.setItem(MODE_KEY, next);
    };

    useEffect(() => {
        if (mode === 'detail') nameRef.current?.focus();
    }, [roomIndex, mode]);

    const resetForm = () => {
        setName('');
        setCategory('');
        setEstValue('');
        setWarranty('');
        setSerial('');
        setPhotos([]);
        if (photoRef.current) photoRef.current.value = '';
    };

    /** Upload the pending photos to an item; failures toast but don't abort. */
    const uploadPending = async (itemId: number) => {
        for (const file of photos) {
            const formData = new FormData();
            formData.append('file', file);
            const photoRes = await fetch(`/api/home/items/${itemId}/photos`, {
                method: 'POST',
                body: formData,
            });
            if (!photoRes.ok) {
                const json = await photoRes.json().catch(() => null);
                toast.error(json?.error ?? `Item saved, but "${file.name}" failed to upload`);
            }
        }
    };

    const recordAdded = (item: HomeItem) => {
        setAdded((prev) => [
            ...prev,
            {
                id: item.id,
                name: item.name,
                estValue: item.estValue,
                roomId: room!.id,
                photoCount: photos.length,
            },
        ]);
    };

    /** Detail mode: create a fully-named item with the pending photos. */
    const addItem = async (): Promise<boolean> => {
        if (!room) return false;
        const trimmed = name.trim();
        if (!trimmed) {
            toast.error('Item name is required');
            nameRef.current?.focus();
            return false;
        }
        setSaving(true);
        try {
            const res = await fetch('/api/home/items', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    roomId: room.id,
                    name: trimmed,
                    category: category || null,
                    estValue: estValue === '' ? null : Number(estValue),
                    warrantyExpires: warranty || null,
                    serial: serial || null,
                }),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                throw new Error(json?.error ?? 'Failed to add item');
            }
            const { item } = (await res.json()) as { item: HomeItem };
            await uploadPending(item.id);
            recordAdded(item);
            resetForm();
            nameRef.current?.focus();
            return true;
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to add item');
            return false;
        } finally {
            setSaving(false);
        }
    };

    /** Photos mode: create a draft (un-named) item holding the pending photos. */
    const addPhotoItem = async (): Promise<boolean> => {
        if (!room) return false;
        if (photos.length === 0) {
            toast.error('Take or choose at least one photo first');
            return false;
        }
        setSaving(true);
        try {
            const res = await fetch('/api/home/items', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ roomId: room.id, draft: true }),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                throw new Error(json?.error ?? 'Failed to add item');
            }
            const { item } = (await res.json()) as { item: HomeItem };
            await uploadPending(item.id);
            recordAdded(item);
            resetForm();
            return true;
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to add item');
            return false;
        } finally {
            setSaving(false);
        }
    };

    /** Save any pending entry before navigating rooms. */
    const flushPending = async (): Promise<boolean> => {
        if (mode === 'photos') return photos.length > 0 ? addPhotoItem() : true;
        return name.trim() ? addItem() : true;
    };

    const handleNextRoom = async () => {
        if (!(await flushPending())) return;
        if (isLastRoom) setFinished(true);
        else setRoomIndex((i) => i + 1);
    };

    const handlePrevRoom = async () => {
        if (isFirstRoom) return;
        if (!(await flushPending())) return;
        setRoomIndex((i) => Math.max(0, i - 1));
    };

    const handleFinish = async () => {
        if (!(await flushPending())) return;
        setFinished(true);
    };

    if (rooms.length === 0) return null;

    const draftCount = added.filter((a) => a.name.trim() === '').length;

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-background">
            <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-4 py-6 sm:px-6">
                {finished ? (
                    <RecapScreen
                        rooms={rooms}
                        added={added}
                        totalValue={totalValue}
                        draftCount={draftCount}
                        onDone={() => onClose(added.length > 0)}
                    />
                ) : (
                    <>
                        {/* Header + progress */}
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <p className="text-[10px] font-medium uppercase tracking-wider text-foreground-muted">
                                    Walk-through · Room {roomIndex + 1} of {rooms.length}
                                </p>
                                <h2 className="mt-1 text-2xl font-bold text-foreground">{room.name}</h2>
                            </div>
                            <button
                                type="button"
                                onClick={() => onClose(added.length > 0)}
                                aria-label="Exit walk-through"
                                className="rounded-lg border border-border px-2.5 py-1 text-sm text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors"
                            >
                                Exit
                            </button>
                        </div>
                        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-background-tertiary">
                            <div
                                className="h-full bg-primary transition-all duration-200"
                                style={{ width: `${((roomIndex + 1) / rooms.length) * 100}%` }}
                            />
                        </div>

                        {/* Mode toggle */}
                        <div className="mt-4 inline-flex rounded-lg border border-border p-0.5 text-xs">
                            {(
                                [
                                    ['photos', 'Photos only'],
                                    ['detail', 'Detail each'],
                                ] as const
                            ).map(([value, label]) => (
                                <button
                                    key={value}
                                    type="button"
                                    onClick={() => chooseMode(value)}
                                    className={`rounded-md px-3 py-1 font-medium transition-colors ${
                                        mode === value
                                            ? 'bg-primary text-primary-foreground'
                                            : 'text-foreground-secondary hover:text-foreground'
                                    }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>

                        {/* Running tally */}
                        <div className="mt-3 flex items-center gap-4 text-xs text-foreground-secondary">
                            <span>
                                <span className="font-mono text-foreground" style={TNUM}>{added.length}</span>{' '}
                                item{added.length === 1 ? '' : 's'} this walk
                            </span>
                            {mode === 'detail' ? (
                                <span>
                                    <span className="font-mono text-foreground" style={TNUM}>
                                        {formatCurrency(totalValue)}
                                    </span>{' '}
                                    total
                                </span>
                            ) : (
                                draftCount > 0 && (
                                    <span>
                                        <span className="font-mono text-foreground" style={TNUM}>
                                            {draftCount}
                                        </span>{' '}
                                        to detail later
                                    </span>
                                )
                            )}
                        </div>

                        {mode === 'photos' ? (
                            /* ---------- Photos-only capture ---------- */
                            <form
                                className="mt-6 space-y-4"
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    void addPhotoItem();
                                }}
                            >
                                <div>
                                    <label className={labelClass}>
                                        Snap the item (and its serial-number label) — name it and add
                                        details later on the desktop.
                                    </label>
                                    <input
                                        ref={photoRef}
                                        type="file"
                                        accept="image/*"
                                        capture="environment"
                                        multiple
                                        onChange={(e) => setPhotos(Array.from(e.target.files ?? []))}
                                        className="block w-full text-sm text-foreground-secondary file:mr-3 file:rounded-lg file:border file:border-border file:bg-background-tertiary file:px-3 file:py-1.5 file:text-sm file:text-foreground-secondary hover:file:border-border-hover file:transition-colors"
                                    />
                                    <p className="mt-1 text-xs text-foreground-muted">
                                        {photos.length > 0
                                            ? `${photos.length} photo${photos.length === 1 ? '' : 's'} ready — tap "Add item" to save this item and clear for the next.`
                                            : 'Multiple photos become one item — e.g. the appliance plus its serial plate.'}
                                    </p>
                                </div>

                                <div className="flex flex-wrap items-center gap-2 pt-2">
                                    <button
                                        type="submit"
                                        disabled={saving || photos.length === 0}
                                        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover transition-colors disabled:opacity-50"
                                    >
                                        {saving ? 'Saving…' : 'Add item'}
                                    </button>
                                    {!isFirstRoom && (
                                        <button
                                            type="button"
                                            onClick={handlePrevRoom}
                                            disabled={saving}
                                            className="rounded-lg border border-border px-4 py-2 text-sm text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors disabled:opacity-50"
                                        >
                                            ← Previous room
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={handleNextRoom}
                                        disabled={saving}
                                        className="rounded-lg border border-border px-4 py-2 text-sm text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors disabled:opacity-50"
                                    >
                                        {isLastRoom ? 'Finish' : 'Next room →'}
                                    </button>
                                    {!isLastRoom && (
                                        <button
                                            type="button"
                                            onClick={handleFinish}
                                            disabled={saving}
                                            className="ml-auto text-sm text-foreground-muted hover:text-foreground transition-colors disabled:opacity-50"
                                        >
                                            Finish walk-through
                                        </button>
                                    )}
                                </div>
                            </form>
                        ) : (
                            /* ---------- Detail-each rapid entry ---------- */
                            <form
                                className="mt-6 space-y-4"
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    void addItem();
                                }}
                            >
                                <div>
                                    <label className={labelClass}>Item name *</label>
                                    <input
                                        ref={nameRef}
                                        type="text"
                                        value={name}
                                        onChange={(e) => setName(e.target.value)}
                                        placeholder={`What's in the ${room.name.toLowerCase()}?`}
                                        className={inputClass}
                                        required
                                    />
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <label className={labelClass}>Category</label>
                                        <select
                                            value={category}
                                            onChange={(e) => setCategory(e.target.value)}
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
                                            value={estValue}
                                            onChange={(e) => setEstValue(e.target.value)}
                                            placeholder="0.00"
                                            className={`${inputClass} font-mono`}
                                            style={TNUM}
                                        />
                                    </div>
                                </div>
                                <div>
                                    <label className={labelClass}>
                                        Photos (optional) — add the item and its serial-number label
                                    </label>
                                    <input
                                        ref={photoRef}
                                        type="file"
                                        accept="image/*"
                                        capture="environment"
                                        multiple
                                        onChange={(e) => setPhotos(Array.from(e.target.files ?? []))}
                                        className="block w-full text-sm text-foreground-secondary file:mr-3 file:rounded-lg file:border file:border-border file:bg-background-tertiary file:px-3 file:py-1.5 file:text-sm file:text-foreground-secondary hover:file:border-border-hover file:transition-colors"
                                    />
                                    {photos.length > 0 && (
                                        <p className="mt-1 text-xs text-foreground-muted">
                                            {photos.length} photo{photos.length === 1 ? '' : 's'} ready to
                                            attach
                                        </p>
                                    )}
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <label className={labelClass}>Warranty until</label>
                                        <input
                                            type="date"
                                            value={warranty}
                                            onChange={(e) => setWarranty(e.target.value)}
                                            className={`${inputClass} font-mono`}
                                        />
                                    </div>
                                    <div>
                                        <label className={labelClass}>Serial #</label>
                                        <input
                                            type="text"
                                            value={serial}
                                            onChange={(e) => setSerial(e.target.value)}
                                            className={`${inputClass} font-mono`}
                                        />
                                    </div>
                                </div>

                                <div className="flex flex-wrap items-center gap-2 pt-2">
                                    <button
                                        type="submit"
                                        disabled={saving}
                                        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover transition-colors disabled:opacity-50"
                                    >
                                        {saving ? 'Saving…' : 'Add & next item'}
                                    </button>
                                    {!isFirstRoom && (
                                        <button
                                            type="button"
                                            onClick={handlePrevRoom}
                                            disabled={saving}
                                            className="rounded-lg border border-border px-4 py-2 text-sm text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors disabled:opacity-50"
                                        >
                                            ← Previous room
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={handleNextRoom}
                                        disabled={saving}
                                        className="rounded-lg border border-border px-4 py-2 text-sm text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors disabled:opacity-50"
                                    >
                                        {isLastRoom ? 'Finish' : 'Next room →'}
                                    </button>
                                    {!isLastRoom && (
                                        <button
                                            type="button"
                                            onClick={handleFinish}
                                            disabled={saving}
                                            className="ml-auto text-sm text-foreground-muted hover:text-foreground transition-colors disabled:opacity-50"
                                        >
                                            Finish walk-through
                                        </button>
                                    )}
                                </div>
                            </form>
                        )}

                        {/* Items captured in this room so far */}
                        {roomAdded.length > 0 && (
                            <div className="mt-6 border border-border rounded-xl bg-background-secondary/30 overflow-hidden">
                                <div className="border-b border-border px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-foreground-muted">
                                    Added in {room.name}
                                    <span className="ml-2 font-mono" style={TNUM}>{roomAdded.length}</span>
                                </div>
                                <ul>
                                    {roomAdded.map((a, i) => (
                                        <li
                                            key={a.id}
                                            className="flex items-center justify-between border-b border-border/30 px-3 py-1.5 text-sm last:border-b-0"
                                        >
                                            <span className="text-foreground">
                                                {a.name.trim() || (
                                                    <span className="text-foreground-muted italic">
                                                        Item {i + 1} · {a.photoCount} photo
                                                        {a.photoCount === 1 ? '' : 's'} · details later
                                                    </span>
                                                )}
                                            </span>
                                            <span className="font-mono text-foreground-secondary" style={TNUM}>
                                                {a.estValue !== null ? formatCurrency(a.estValue) : '—'}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

function RecapScreen({
    rooms,
    added,
    totalValue,
    draftCount,
    onDone,
}: {
    rooms: HomeRoom[];
    added: AddedItem[];
    totalValue: number;
    draftCount: number;
    onDone: () => void;
}) {
    const perRoom = rooms
        .map((r) => {
            const items = added.filter((a) => a.roomId === r.id);
            return {
                room: r,
                count: items.length,
                value: items.reduce((sum, a) => sum + (a.estValue ?? 0), 0),
            };
        })
        .filter((r) => r.count > 0);

    return (
        <div className="flex flex-1 flex-col justify-center py-8">
            <p className="text-[10px] font-medium uppercase tracking-wider text-foreground-muted">
                Walk-through complete
            </p>
            <h2 className="mt-1 text-2xl font-bold text-foreground">
                {added.length} item{added.length === 1 ? '' : 's'} added
            </h2>
            {totalValue > 0 && (
                <p className="mt-2 text-sm text-foreground-secondary">
                    Estimated value captured this walk:{' '}
                    <span className="font-mono font-medium text-foreground" style={TNUM}>
                        {formatCurrency(totalValue)}
                    </span>
                </p>
            )}
            {draftCount > 0 && (
                <p className="mt-2 text-sm text-warning">
                    {draftCount} item{draftCount === 1 ? '' : 's'} still need names and details — head
                    to the desktop and use “{draftCount} need details” on the inventory page to fill
                    them in.
                </p>
            )}

            {perRoom.length > 0 && (
                <div className="mt-6 border border-border rounded-xl bg-background-secondary/30 overflow-hidden">
                    <ul>
                        {perRoom.map(({ room, count, value }) => (
                            <li
                                key={room.id}
                                className="flex items-center justify-between border-b border-border/30 px-4 py-2 text-sm last:border-b-0"
                            >
                                <span className="text-foreground">
                                    {room.name}
                                    <span className="ml-2 text-xs text-foreground-muted">
                                        {count} item{count === 1 ? '' : 's'}
                                    </span>
                                </span>
                                <span className="font-mono text-foreground-secondary" style={TNUM}>
                                    {value > 0 ? formatCurrency(value) : '—'}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {added.length === 0 && (
                <p className="mt-4 text-sm text-foreground-muted">
                    Nothing added this time — you can restart the walk-through whenever you like.
                </p>
            )}

            <div className="mt-8">
                <button
                    type="button"
                    onClick={onDone}
                    className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover transition-colors"
                >
                    Done
                </button>
            </div>
        </div>
    );
}
