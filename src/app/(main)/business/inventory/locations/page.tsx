'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Modal } from '@/components/ui/Modal';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { MobileCard } from '@/components/ui/MobileCard';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import type { LocationDTO } from '@/components/business/inventory-ui';

const inputClass = 'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';
const labelClass = 'block text-xs font-medium text-foreground-secondary mb-1';

function StatusBadge({ active }: { active: boolean }) {
    return active ? (
        <span className="inline-block px-2 py-0.5 text-xs rounded-md bg-positive/10 text-positive">Active</span>
    ) : (
        <span className="inline-block px-2 py-0.5 text-xs rounded-md bg-surface-hover text-foreground-muted">Inactive</span>
    );
}

export default function InventoryLocationsPage() {
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();

    const [locations, setLocations] = useState<LocationDTO[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    const [editing, setEditing] = useState<'new' | LocationDTO | null>(null);
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [active, setActive] = useState(true);
    const [saving, setSaving] = useState(false);
    const [deactivating, setDeactivating] = useState<LocationDTO | null>(null);
    const [isDeactivating, setIsDeactivating] = useState(false);

    const fetchLocations = useCallback(async () => {
        try {
            const res = await fetch('/api/inventory/locations?includeInactive=true');
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to load locations');
            setLocations(data.locations);
            setLoadError(null);
        } catch (err) {
            setLoadError(err instanceof Error ? err.message : 'Failed to load locations');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchLocations(); }, [fetchLocations]);

    const openCreate = () => {
        setName('');
        setDescription('');
        setActive(true);
        setEditing('new');
    };

    const openEdit = (location: LocationDTO) => {
        setName(location.name);
        setDescription(location.description ?? '');
        setActive(location.active);
        setEditing(location);
    };

    const handleSave = async () => {
        if (!name.trim()) {
            error('Name is required');
            return;
        }
        setSaving(true);
        try {
            const isNew = editing === 'new';
            const url = isNew
                ? '/api/inventory/locations'
                : `/api/inventory/locations/${(editing as LocationDTO).id}`;
            const res = await fetch(url, {
                method: isNew ? 'POST' : 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: name.trim(),
                    description: description.trim() || null,
                    ...(isNew ? {} : { active }),
                }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to save location');
            success(isNew ? 'Location created' : 'Location updated');
            setEditing(null);
            await fetchLocations();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save location');
        } finally {
            setSaving(false);
        }
    };

    const handleToggleActive = async (location: LocationDTO) => {
        try {
            const res = await fetch(`/api/inventory/locations/${location.id}`, {
                method: location.active ? 'DELETE' : 'PUT',
                ...(location.active
                    ? {}
                    : {
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ active: true }),
                    }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to update location');
            success(location.active ? `Deactivated ${location.name}` : `Activated ${location.name}`);
            await fetchLocations();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to update location');
        }
    };

    const handleDeactivate = async () => {
        if (!deactivating) return;
        setIsDeactivating(true);
        try {
            await handleToggleActive(deactivating);
            setDeactivating(null);
        } finally {
            setIsDeactivating(false);
        }
    };

    return (
        <div className="space-y-4">
            <PageHeader
                title="Inventory Locations"
                subtitle="Warehouses and bins where stock is held."
                actions={
                    <button
                        type="button"
                        onClick={openCreate}
                        disabled={isReadonly}
                        title={isReadonly ? READONLY_TOOLTIP : undefined}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors whitespace-nowrap"
                    >
                        + New Location
                    </button>
                }
            />

            <div className="text-sm">
                <Link href="/business/inventory" className="text-foreground-muted hover:text-foreground transition-colors">
                    ← Inventory
                </Link>
            </div>

            <div className="bg-surface border border-border rounded-lg overflow-hidden">
                {loading ? (
                    <div className="p-12 flex items-center justify-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading locations...</span>
                    </div>
                ) : loadError ? (
                    <div className="p-12 text-center space-y-2">
                        <p className="text-negative text-sm">{loadError}</p>
                        <button
                            type="button"
                            onClick={() => { setLoading(true); fetchLocations(); }}
                            className="px-3 py-1.5 text-xs rounded-md text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors"
                        >
                            Retry
                        </button>
                    </div>
                ) : locations.length === 0 ? (
                    <div className="p-12 text-center text-foreground-muted">
                        No locations yet. Create one to start receiving stock.
                    </div>
                ) : (
                    <>
                        {/* Desktop table */}
                        <div className="hidden md:block overflow-x-auto">
                            <table className="w-full text-left text-[13px]">
                                <thead>
                                    <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                        <th className="px-4 py-2 font-semibold">Name</th>
                                        <th className="px-4 py-2 font-semibold">Description</th>
                                        <th className="px-4 py-2 font-semibold">Status</th>
                                        <th className="px-4 py-2 font-semibold text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border">
                                    {locations.map((location) => (
                                        <tr key={location.id} className="hover:bg-surface-hover/50 transition-colors">
                                            <td className="px-4 py-2 text-foreground">{location.name}</td>
                                            <td className="px-4 py-2 text-foreground-secondary max-w-md truncate">
                                                {location.description || <span className="text-foreground-muted">—</span>}
                                            </td>
                                            <td className="px-4 py-2">
                                                <StatusBadge active={location.active} />
                                            </td>
                                            <td className="px-4 py-2 text-right whitespace-nowrap">
                                                <button
                                                    type="button"
                                                    onClick={() => openEdit(location)}
                                                    className="px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                                                >
                                                    Edit
                                                </button>
                                                {location.active ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => setDeactivating(location)}
                                                        disabled={isReadonly}
                                                        title={isReadonly ? READONLY_TOOLTIP : undefined}
                                                        className="ml-1 px-2 py-1 text-xs rounded-md text-negative hover:bg-negative/10 transition-colors disabled:opacity-50"
                                                    >
                                                        Deactivate
                                                    </button>
                                                ) : (
                                                    <button
                                                        type="button"
                                                        onClick={() => handleToggleActive(location)}
                                                        disabled={isReadonly}
                                                        title={isReadonly ? READONLY_TOOLTIP : undefined}
                                                        className="ml-1 px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
                                                    >
                                                        Activate
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {/* Mobile cards */}
                        <div className="md:hidden">
                            {locations.map((location) => (
                                <MobileCard
                                    key={location.id}
                                    onClick={() => openEdit(location)}
                                    fields={[
                                        { label: 'Name', value: location.name },
                                        ...(location.description
                                            ? [{ label: 'Description', value: <span className="truncate">{location.description}</span> }]
                                            : []),
                                        { label: 'Status', value: <StatusBadge active={location.active} /> },
                                    ]}
                                />
                            ))}
                        </div>
                    </>
                )}
            </div>

            {/* Create / edit modal */}
            <Modal
                isOpen={!!editing}
                onClose={() => setEditing(null)}
                title={editing === 'new' ? 'New Location' : 'Edit Location'}
                size="sm"
            >
                <form
                    className="px-6 py-4 space-y-3"
                    onSubmit={(e) => {
                        e.preventDefault();
                        handleSave();
                    }}
                >
                    <div>
                        <label className={labelClass}>Name *</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className={inputClass}
                            placeholder="e.g. Main warehouse"
                            autoFocus
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Description</label>
                        <input
                            type="text"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            className={inputClass}
                            placeholder="Optional"
                        />
                    </div>
                    {editing !== 'new' && (
                        <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                            <input
                                type="checkbox"
                                checked={active}
                                onChange={(e) => setActive(e.target.checked)}
                                className="accent-primary"
                            />
                            Active
                        </label>
                    )}
                    <div className="flex justify-end gap-3 pt-2 border-t border-border">
                        <button
                            type="button"
                            onClick={() => setEditing(null)}
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

            <ConfirmationDialog
                isOpen={!!deactivating}
                onConfirm={handleDeactivate}
                onCancel={() => setDeactivating(null)}
                title="Deactivate Location"
                message={deactivating
                    ? `Deactivate ${deactivating.name}? It is hidden from stock-action pickers; movement history is preserved and you can reactivate it later.`
                    : ''}
                confirmLabel="Deactivate"
                confirmVariant="danger"
                isLoading={isDeactivating}
            />
        </div>
    );
}
