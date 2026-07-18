'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { HomeSummary, RoomSummary } from '@/lib/services/home.service';
import { formatCurrency } from '@/lib/format';
import { PageHeader } from '@/components/ui/PageHeader';
import { PersonalToolNotice } from '@/components/PersonalToolNotice';
import { useToast } from '@/contexts/ToastContext';
import { WalkthroughOverlay } from '@/components/home/WalkthroughOverlay';
import { RoomDetailPanel } from '@/components/home/RoomDetailPanel';
import { BulkDetailPanel } from '@/components/home/BulkDetailPanel';
import { inputClass, TNUM } from '@/components/home/home-shared';

export default function HomeInventoryPage() {
    const toast = useToast();
    const [summary, setSummary] = useState<HomeSummary | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [selectedRoomId, setSelectedRoomId] = useState<number | null>(null);
    const [walking, setWalking] = useState(false);
    const [startingWalk, setStartingWalk] = useState(false);
    const [bulkDetailing, setBulkDetailing] = useState(false);

    const [addingRoom, setAddingRoom] = useState(false);
    const [newRoomName, setNewRoomName] = useState('');

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/home/summary');
            if (!res.ok) throw new Error(`Request failed (${res.status})`);
            setSummary(await res.json());
            setError(null);
        } catch {
            setError('Failed to load home inventory.');
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            await load();
            if (!cancelled) setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [load]);

    /**
     * "Start walk-through": on first use (zero rooms) this seeds the default
     * room set — Living Room, Kitchen, … — all editable afterwards.
     */
    const startWalkthrough = async () => {
        if (!summary) return;
        setStartingWalk(true);
        try {
            if (summary.rooms.length === 0) {
                const res = await fetch('/api/home/rooms/seed', { method: 'POST' });
                if (!res.ok) {
                    const json = await res.json().catch(() => null);
                    throw new Error(json?.error ?? 'Failed to set up rooms');
                }
                await load();
            }
            setWalking(true);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to start walk-through');
        } finally {
            setStartingWalk(false);
        }
    };

    const handleAddRoom = async () => {
        const name = newRoomName.trim();
        if (!name) return;
        try {
            const res = await fetch('/api/home/rooms', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                throw new Error(json?.error ?? 'Failed to add room');
            }
            toast.success('Room added');
            setNewRoomName('');
            setAddingRoom(false);
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to add room');
        }
    };

    const rooms = summary?.rooms ?? [];
    const selectedRoom = rooms.find((r) => r.id === selectedRoomId) ?? null;
    const warrantyAlertCount =
        (summary?.warrantyExpired.length ?? 0) + (summary?.warrantyExpiringSoon.length ?? 0);

    return (
        <div className="space-y-6">
            <PageHeader
                title="Home Inventory"
                subtitle="A room-by-room record of what you own — for insurance coverage, warranties, and serial numbers."
                actions={
                    !selectedRoom && !bulkDetailing ? (
                        <button
                            type="button"
                            onClick={startWalkthrough}
                            disabled={startingWalk || loading}
                            className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover transition-colors disabled:opacity-50"
                        >
                            {startingWalk ? 'Setting up…' : 'Start walk-through'}
                        </button>
                    ) : undefined
                }
            />

            <PersonalToolNotice />

            {loading && (
                <div className="flex items-center justify-center py-12">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading...</span>
                    </div>
                </div>
            )}

            {!loading && error && (
                <div className="border border-error/30 bg-surface/30 rounded-xl p-4">
                    <p className="text-sm text-error">{error}</p>
                </div>
            )}

            {!loading && !error && summary && selectedRoom && (
                <RoomDetailPanel
                    room={selectedRoom}
                    rooms={rooms}
                    onBack={() => setSelectedRoomId(null)}
                    onChanged={() => void load()}
                    onRoomDeleted={() => {
                        setSelectedRoomId(null);
                        void load();
                    }}
                />
            )}

            {!loading && !error && summary && !selectedRoom && bulkDetailing && (
                <BulkDetailPanel
                    rooms={rooms.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sortOrder }))}
                    onBack={() => setBulkDetailing(false)}
                    onChanged={() => void load()}
                />
            )}

            {!loading && !error && summary && !selectedRoom && !bulkDetailing && (
                <>
                    {/* Drafts awaiting details */}
                    {summary.draftItems > 0 && (
                        <button
                            type="button"
                            onClick={() => setBulkDetailing(true)}
                            className="flex w-full items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-left transition-colors hover:bg-primary/10"
                        >
                            <span className="text-sm text-foreground">
                                <span className="font-mono font-medium" style={TNUM}>
                                    {summary.draftItems}
                                </span>{' '}
                                item{summary.draftItems === 1 ? '' : 's'} captured without details —
                                add names, categories, and values
                            </span>
                            <span className="shrink-0 text-sm font-medium text-primary">
                                Add details →
                            </span>
                        </button>
                    )}

                    {/* Coverage hero */}
                    <div className="bg-background-secondary/30 border border-border rounded-xl p-5">
                        <p className="text-[10px] font-medium uppercase tracking-wider text-foreground-muted">
                            Estimated contents value
                        </p>
                        <p className="mt-1 font-mono text-3xl font-semibold text-foreground" style={TNUM}>
                            {formatCurrency(summary.totalValue)}
                        </p>
                        <p className="mt-2 text-sm text-foreground-secondary">
                            Across{' '}
                            <span className="font-mono" style={TNUM}>{summary.totalItems}</span> item
                            {summary.totalItems === 1 ? '' : 's'} in{' '}
                            <span className="font-mono" style={TNUM}>{rooms.length}</span> room
                            {rooms.length === 1 ? '' : 's'} — review your homeowner&apos;s/renter&apos;s
                            contents coverage against this number.
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-foreground-secondary">
                            {summary.warrantyExpired.length > 0 && (
                                <span className="text-error">
                                    {summary.warrantyExpired.length} warrant
                                    {summary.warrantyExpired.length === 1 ? 'y' : 'ies'} expired
                                </span>
                            )}
                            {summary.warrantyExpiringSoon.length > 0 && (
                                <span className="text-warning">
                                    {summary.warrantyExpiringSoon.length} warrant
                                    {summary.warrantyExpiringSoon.length === 1 ? 'y' : 'ies'} ending
                                    within {summary.warrantyWarningDays} days
                                </span>
                            )}
                            <Link
                                href="/home/maintenance"
                                className="text-primary hover:text-primary-hover transition-colors"
                            >
                                Home maintenance
                                {summary.tasksOverdue > 0 && ` · ${summary.tasksOverdue} overdue`} →
                            </Link>
                        </div>
                    </div>

                    {/* Warranty alert detail */}
                    {warrantyAlertCount > 0 && (
                        <div className="border border-warning/30 bg-warning/5 rounded-xl px-4 py-3 text-sm text-foreground-secondary">
                            {[...summary.warrantyExpired, ...summary.warrantyExpiringSoon]
                                .slice(0, 6)
                                .map((a) => (
                                    <span key={a.itemId} className="mr-4 inline-block">
                                        <button
                                            type="button"
                                            onClick={() => setSelectedRoomId(a.roomId)}
                                            className="text-foreground hover:text-primary transition-colors"
                                        >
                                            {a.itemName}
                                        </button>{' '}
                                        <span className={a.daysUntil < 0 ? 'text-error' : 'text-warning'}>
                                            {a.daysUntil < 0
                                                ? `expired ${a.warrantyExpires}`
                                                : `ends in ${a.daysUntil}d`}
                                        </span>
                                    </span>
                                ))}
                            {warrantyAlertCount > 6 && (
                                <span className="text-foreground-muted">
                                    +{warrantyAlertCount - 6} more
                                </span>
                            )}
                        </div>
                    )}

                    {/* Room cards */}
                    {rooms.length === 0 ? (
                        <div className="bg-background-secondary/30 border border-border rounded-xl p-8 text-center space-y-2">
                            <p className="text-sm text-foreground-secondary">
                                No rooms yet. Tap{' '}
                                <span className="font-medium text-foreground">Start walk-through</span>{' '}
                                to set up a standard room list (Living Room, Kitchen, Garage, …) and
                                capture items one room at a time — or add rooms by hand below.
                            </p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            {rooms.map((room: RoomSummary) => (
                                <button
                                    key={room.id}
                                    type="button"
                                    onClick={() => setSelectedRoomId(room.id)}
                                    className="rounded-xl border border-border bg-background-secondary/30 p-4 text-left transition-colors hover:border-border-hover hover:bg-surface-hover"
                                >
                                    <p className="text-sm font-medium text-foreground">{room.name}</p>
                                    <p className="mt-1 text-xs text-foreground-secondary">
                                        <span className="font-mono" style={TNUM}>{room.itemCount}</span> item
                                        {room.itemCount === 1 ? '' : 's'}
                                    </p>
                                    <p className="mt-2 font-mono text-sm text-foreground-secondary" style={TNUM}>
                                        {formatCurrency(room.totalValue)}
                                    </p>
                                </button>
                            ))}
                        </div>
                    )}

                    {/* Add room */}
                    <div>
                        {addingRoom ? (
                            <form
                                className="flex items-center gap-2"
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    void handleAddRoom();
                                }}
                            >
                                <input
                                    type="text"
                                    value={newRoomName}
                                    onChange={(e) => setNewRoomName(e.target.value)}
                                    placeholder="Room name"
                                    className={`${inputClass} w-56`}
                                    autoFocus
                                />
                                <button
                                    type="submit"
                                    className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover transition-colors"
                                >
                                    Add
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setAddingRoom(false);
                                        setNewRoomName('');
                                    }}
                                    className="rounded-lg border border-border px-4 py-1.5 text-sm text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors"
                                >
                                    Cancel
                                </button>
                            </form>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setAddingRoom(true)}
                                className="text-sm text-primary hover:text-primary-hover transition-colors"
                            >
                                + Add room
                            </button>
                        )}
                    </div>
                </>
            )}

            {walking && summary && (
                <WalkthroughOverlay
                    rooms={rooms.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sortOrder }))}
                    onClose={(changed) => {
                        setWalking(false);
                        if (changed) void load();
                    }}
                />
            )}
        </div>
    );
}
