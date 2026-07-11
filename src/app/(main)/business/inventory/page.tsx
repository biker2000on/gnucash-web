'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/ui/PageHeader';
import { FilterBar } from '@/components/ui/FilterBar';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import { MobileCard } from '@/components/ui/MobileCard';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { ItemFormModal } from '@/components/business/ItemFormModal';
import { ItemSelector } from '@/components/business/ItemSelector';
import { MovementsTable } from '@/components/business/MovementsTable';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut';
import { formatCurrency } from '@/lib/format';
import {
    type ItemDTO,
    type LocationDTO,
    type MovementDTO,
    type MovementType,
    type ItemSortKey,
    type SortDir,
    MOVEMENT_TYPE_META,
    compareItems,
    lowStockCount,
    belowReorderCount,
    isBelowReorder,
    totalStockValue,
    formatQty,
} from '@/components/business/inventory-ui';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;
const inputClass = 'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';

type ActiveFilter = 'active' | 'inactive' | 'all';
type View = 'items' | 'movements';

// ---------------------------------------------------------------------------
// Items view
// ---------------------------------------------------------------------------

function SortHeader({
    label,
    sortKey,
    current,
    dir,
    onSort,
    numeric = false,
}: {
    label: string;
    sortKey: ItemSortKey;
    current: ItemSortKey;
    dir: SortDir;
    onSort: (key: ItemSortKey) => void;
    numeric?: boolean;
}) {
    const active = current === sortKey;
    return (
        <th className={`px-4 py-2 font-semibold ${numeric ? 'text-right' : ''}`}>
            <button
                type="button"
                onClick={() => onSort(sortKey)}
                className={`inline-flex items-center gap-1 uppercase tracking-widest transition-colors ${
                    active ? 'text-foreground' : 'hover:text-foreground'
                }`}
            >
                {label}
                <span className={`text-[10px] ${active ? 'opacity-100' : 'opacity-0'}`}>
                    {active && dir === 'desc' ? '▼' : '▲'}
                </span>
            </button>
        </th>
    );
}

function ItemStatusBadge({ active }: { active: boolean }) {
    return active ? (
        <span className="inline-block px-2 py-0.5 text-xs rounded-md bg-positive/10 text-positive">Active</span>
    ) : (
        <span className="inline-block px-2 py-0.5 text-xs rounded-md bg-surface-hover text-foreground-muted">Inactive</span>
    );
}

// ---------------------------------------------------------------------------
// Movements view (recent movements across items, with filters)
// ---------------------------------------------------------------------------

function MovementsView({
    items,
    locations,
}: {
    items: ItemDTO[];
    locations: LocationDTO[];
}) {
    const { error } = useToast();
    const [movements, setMovements] = useState<MovementDTO[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);

    const [itemId, setItemId] = useState<number | null>(null);
    const [locationId, setLocationId] = useState('');
    const [type, setType] = useState('');
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');

    const PAGE = 50;

    const buildParams = useCallback((offset: number) => {
        const params = new URLSearchParams();
        if (itemId != null) params.set('itemId', String(itemId));
        if (locationId) params.set('locationId', locationId);
        if (type) params.set('type', type);
        if (dateFrom) params.set('dateFrom', dateFrom);
        if (dateTo) params.set('dateTo', dateTo);
        params.set('limit', String(PAGE));
        params.set('offset', String(offset));
        return params;
    }, [itemId, locationId, type, dateFrom, dateTo]);

    const fetchMovements = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/inventory/movements?${buildParams(0)}`);
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to load movements');
            setMovements(data.movements);
            setTotal(data.total);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load movements');
        } finally {
            setLoading(false);
        }
    }, [buildParams, error]);

    useEffect(() => { fetchMovements(); }, [fetchMovements]);

    const loadMore = async () => {
        setLoadingMore(true);
        try {
            const res = await fetch(`/api/inventory/movements?${buildParams(movements.length)}`);
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to load movements');
            setMovements((prev) => [...prev, ...data.movements]);
            setTotal(data.total);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load movements');
        } finally {
            setLoadingMore(false);
        }
    };

    const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
    const locationById = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations]);

    const activeFilterCount =
        (itemId != null ? 1 : 0) + (locationId ? 1 : 0) + (type ? 1 : 0) + (dateFrom ? 1 : 0) + (dateTo ? 1 : 0);

    return (
        <div className="space-y-3">
            <FilterBar
                primary={
                    <div className="flex items-center gap-1 md:w-72">
                        <ItemSelector
                            value={itemId}
                            onChange={(id) => setItemId(id)}
                            items={items}
                            placeholder="All items"
                            compact
                            className="flex-1 min-w-0"
                        />
                        {itemId != null && (
                            <button
                                type="button"
                                onClick={() => setItemId(null)}
                                className="px-1.5 py-0.5 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors shrink-0"
                                title="Clear item filter"
                            >
                                ✕
                            </button>
                        )}
                    </div>
                }
                activeCount={activeFilterCount}
            >
                <select
                    value={locationId}
                    onChange={(e) => setLocationId(e.target.value)}
                    className={`${inputClass} md:w-40`}
                >
                    <option value="">All locations</option>
                    {locations.map((l) => (
                        <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                </select>
                <select
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    className={`${inputClass} md:w-40`}
                >
                    <option value="">All types</option>
                    {(Object.keys(MOVEMENT_TYPE_META) as MovementType[]).map((t) => (
                        <option key={t} value={t}>{MOVEMENT_TYPE_META[t].label}</option>
                    ))}
                </select>
                <input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className={`${inputClass} md:w-40 font-mono`}
                    style={TNUM}
                    title="From date"
                />
                <input
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className={`${inputClass} md:w-40 font-mono`}
                    style={TNUM}
                    title="To date"
                />
            </FilterBar>

            <div className="bg-surface border border-border rounded-lg overflow-hidden">
                {loading ? (
                    <div className="p-12 flex items-center justify-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading movements...</span>
                    </div>
                ) : (
                    <>
                        <MovementsTable
                            movements={movements}
                            itemLabel={(id) => {
                                const item = itemById.get(id);
                                return item ? `${item.sku} — ${item.name}` : `#${id}`;
                            }}
                            locationLabel={(id) => locationById.get(id)?.name ?? `#${id}`}
                            linkItems
                            emptyMessage="No stock movements match these filters."
                        />
                        {movements.length < total && (
                            <div className="px-4 py-3 border-t border-border text-center">
                                <button
                                    type="button"
                                    onClick={loadMore}
                                    disabled={loadingMore}
                                    className="px-3 py-1.5 text-xs rounded-md text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
                                >
                                    {loadingMore
                                        ? 'Loading...'
                                        : `Load more (${movements.length} of ${total})`}
                                </button>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function InventoryPage() {
    const router = useRouter();
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();

    const [view, setView] = useState<View>('items');
    const [items, setItems] = useState<ItemDTO[]>([]);
    const [locations, setLocations] = useState<LocationDTO[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    const [search, setSearch] = useState('');
    const [activeFilter, setActiveFilter] = useState<ActiveFilter>('active');
    const [sortKey, setSortKey] = useState<ItemSortKey>('sku');
    const [sortDir, setSortDir] = useState<SortDir>('asc');

    const [editing, setEditing] = useState<'new' | ItemDTO | null>(null);
    const [deactivating, setDeactivating] = useState<ItemDTO | null>(null);
    const [isDeactivating, setIsDeactivating] = useState(false);
    const [scanning, setScanning] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const handleReorderScan = async () => {
        setScanning(true);
        try {
            const res = await fetch('/api/inventory/reorder-scan', { method: 'POST' });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to scan reorder points');
            success(
                data.detected === 0
                    ? 'All items are above their reorder points'
                    : `${data.detected} item${data.detected === 1 ? '' : 's'} at/below reorder point — ${data.created} new alert${data.created === 1 ? '' : 's'}`,
            );
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to scan reorder points');
        } finally {
            setScanning(false);
        }
    };

    const fetchItems = useCallback(async () => {
        try {
            const params = new URLSearchParams({ includeInactive: 'true' });
            if (search.trim()) params.set('search', search.trim());
            const res = await fetch(`/api/inventory/items?${params}`);
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to load items');
            setItems(data.items);
            setLoadError(null);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to load items';
            setLoadError(message);
        } finally {
            setLoading(false);
        }
    }, [search]);

    // Debounced refetch on search changes.
    useEffect(() => {
        const t = setTimeout(fetchItems, 250);
        return () => clearTimeout(t);
    }, [fetchItems]);

    useEffect(() => {
        fetch('/api/inventory/locations')
            .then((res) => (res.ok ? res.json() : { locations: [] }))
            .then((data: { locations: LocationDTO[] }) => setLocations(data.locations ?? []))
            .catch(() => {});
    }, []);

    // '/' focuses search; 'n' (global open-new-transaction event) opens the
    // new-item modal — same repurposing pattern as ContactManager.
    useKeyboardShortcut(
        'inventory-focus-search',
        '/',
        'Search items',
        () => searchInputRef.current?.focus(),
        'page',
        view === 'items' && !editing && !deactivating,
    );

    useEffect(() => {
        const handler = () => {
            if (!isReadonly) setEditing('new');
        };
        window.addEventListener('open-new-transaction', handler);
        return () => window.removeEventListener('open-new-transaction', handler);
    }, [isReadonly]);

    const handleSort = (key: ItemSortKey) => {
        if (key === sortKey) {
            setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        } else {
            setSortKey(key);
            setSortDir('asc');
        }
    };

    const visibleItems = useMemo(() => {
        const filtered = items.filter((i) =>
            activeFilter === 'all' ? true : activeFilter === 'active' ? i.active : !i.active,
        );
        return [...filtered].sort((a, b) => compareItems(a, b, sortKey, sortDir));
    }, [items, activeFilter, sortKey, sortDir]);

    const handleToggleActive = async (item: ItemDTO) => {
        try {
            const res = await fetch(`/api/inventory/items/${item.id}`, {
                method: item.active ? 'DELETE' : 'PUT',
                ...(item.active
                    ? {}
                    : {
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ active: true }),
                    }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to update item');
            success(item.active ? `Deactivated ${item.sku}` : `Activated ${item.sku}`);
            await fetchItems();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to update item');
        }
    };

    const handleDeactivate = async () => {
        if (!deactivating) return;
        setIsDeactivating(true);
        try {
            const res = await fetch(`/api/inventory/items/${deactivating.id}`, { method: 'DELETE' });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to deactivate item');
            success(`Deactivated ${deactivating.sku}`);
            setDeactivating(null);
            await fetchItems();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to deactivate item');
        } finally {
            setIsDeactivating(false);
        }
    };

    const filterButton = (value: ActiveFilter, label: string) => (
        <button
            type="button"
            onClick={() => setActiveFilter(value)}
            className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                activeFilter === value
                    ? 'bg-primary-light text-primary'
                    : 'text-foreground-secondary hover:text-foreground hover:bg-surface-hover'
            }`}
        >
            {label}
        </button>
    );

    const viewTab = (value: View, label: string) => (
        <button
            type="button"
            onClick={() => setView(value)}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                view === value
                    ? 'bg-primary-light text-primary'
                    : 'text-foreground-secondary hover:text-foreground hover:bg-surface-hover'
            }`}
        >
            {label}
        </button>
    );

    const activeItems = useMemo(() => items.filter((i) => i.active), [items]);
    const activeLocations = useMemo(() => locations.filter((l) => l.active), [locations]);
    const lowStock = useMemo(() => lowStockCount(items), [items]);
    const reorderLow = useMemo(() => belowReorderCount(items), [items]);
    // Distinct active items that are out of stock OR at/below reorder point.
    const anyLow = useMemo(
        () => items.filter((i) => i.active && (i.onHand <= 0 || isBelowReorder(i))).length,
        [items],
    );
    const stockValue = useMemo(() => totalStockValue(items), [items]);

    const rowActions = (item: ItemDTO) => [
        { label: 'Open', onSelect: () => router.push(`/business/inventory/${item.id}`) },
        { label: 'Edit', onSelect: () => setEditing(item) },
        item.active
            ? { label: 'Deactivate', onSelect: () => setDeactivating(item), destructive: true, disabled: isReadonly }
            : { label: 'Activate', onSelect: () => handleToggleActive(item), disabled: isReadonly },
    ];

    return (
        <div className="space-y-4">
            <PageHeader
                title="Inventory"
                subtitle="Items, stock levels, and movements. Valuation is book-wide — moving average or FIFO per item."
                actions={
                    <>
                        <button
                            type="button"
                            onClick={handleReorderScan}
                            disabled={isReadonly || scanning}
                            title={isReadonly ? READONLY_TOOLTIP : 'Create alerts for items at or below their reorder point'}
                            className="px-3 py-2 text-sm rounded-lg border border-border bg-surface/50 text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                        >
                            {scanning ? 'Scanning...' : 'Scan reorder points'}
                        </button>
                        <button
                            type="button"
                            onClick={() => setEditing('new')}
                            disabled={isReadonly}
                            title={isReadonly ? READONLY_TOOLTIP : 'New Item (n)'}
                            className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors whitespace-nowrap"
                        >
                            + New Item
                        </button>
                    </>
                }
                menuActions={[
                    { label: 'Manage locations', onSelect: () => router.push('/business/inventory/locations') },
                ]}
            />

            <StatGrid cols={4}>
                <StatCard label="Active items" value={loading ? '—' : String(activeItems.length)} size="compact" />
                <StatCard
                    label="Stock value"
                    value={loading ? '—' : formatCurrency(stockValue)}
                    sub="at avg cost"
                    size="compact"
                />
                <StatCard
                    label="Locations"
                    value={String(activeLocations.length)}
                    sub={<Link href="/business/inventory/locations" className="text-primary hover:text-primary-hover">Manage →</Link>}
                    size="compact"
                />
                <StatCard
                    label="Low stock"
                    value={loading ? '—' : String(anyLow)}
                    tone={anyLow > 0 ? 'warning' : 'default'}
                    sub={loading ? undefined : `${lowStock} at ≤ 0 · ${reorderLow} at reorder point`}
                    size="compact"
                />
            </StatGrid>

            <div className="flex items-center gap-1 border-b border-border pb-2">
                {viewTab('items', 'Items')}
                {viewTab('movements', 'Stock Movements')}
            </div>

            {view === 'movements' ? (
                <MovementsView items={items} locations={locations} />
            ) : (
                <>
                    <FilterBar
                        primary={
                            <input
                                ref={searchInputRef}
                                type="text"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Escape') {
                                        e.preventDefault();
                                        if (search) setSearch('');
                                        else searchInputRef.current?.blur();
                                    }
                                }}
                                placeholder="Search by SKU or name... ( / )"
                                className={`${inputClass} md:max-w-sm`}
                            />
                        }
                        activeCount={activeFilter !== 'active' ? 1 : 0}
                    >
                        <div className="flex gap-1">
                            {filterButton('active', 'Active')}
                            {filterButton('inactive', 'Inactive')}
                            {filterButton('all', 'All')}
                        </div>
                    </FilterBar>

                    <div className="bg-surface border border-border rounded-lg overflow-hidden">
                        {loading ? (
                            <div className="p-12 flex items-center justify-center gap-3">
                                <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                                <span className="text-foreground-secondary">Loading items...</span>
                            </div>
                        ) : loadError ? (
                            <div className="p-12 text-center space-y-2">
                                <p className="text-negative text-sm">{loadError}</p>
                                <button
                                    type="button"
                                    onClick={() => { setLoading(true); fetchItems(); }}
                                    className="px-3 py-1.5 text-xs rounded-md text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors"
                                >
                                    Retry
                                </button>
                            </div>
                        ) : visibleItems.length === 0 ? (
                            <div className="p-12 text-center text-foreground-muted">
                                {items.length === 0
                                    ? 'No inventory items yet. Create one to get started.'
                                    : 'No items match these filters.'}
                            </div>
                        ) : (
                            <>
                                {/* Desktop table */}
                                <div className="hidden md:block overflow-x-auto">
                                    <table className="w-full text-left text-[13px]">
                                        <thead>
                                            <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                                <SortHeader label="SKU" sortKey="sku" current={sortKey} dir={sortDir} onSort={handleSort} />
                                                <SortHeader label="Name" sortKey="name" current={sortKey} dir={sortDir} onSort={handleSort} />
                                                <SortHeader label="Unit" sortKey="unit" current={sortKey} dir={sortDir} onSort={handleSort} />
                                                <SortHeader label="On hand" sortKey="onHand" current={sortKey} dir={sortDir} onSort={handleSort} numeric />
                                                <SortHeader label="Avg cost" sortKey="avgCost" current={sortKey} dir={sortDir} onSort={handleSort} numeric />
                                                <SortHeader label="Stock value" sortKey="stockValue" current={sortKey} dir={sortDir} onSort={handleSort} numeric />
                                                <SortHeader label="Sale price" sortKey="salePrice" current={sortKey} dir={sortDir} onSort={handleSort} numeric />
                                                <th className="px-4 py-2 font-semibold">Status</th>
                                                <th className="px-4 py-2 font-semibold text-right">Actions</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-border">
                                            {visibleItems.map((item) => (
                                                <tr
                                                    key={item.id}
                                                    className="hover:bg-surface-hover/50 transition-colors cursor-pointer"
                                                    onClick={() => router.push(`/business/inventory/${item.id}`)}
                                                >
                                                    <td className="px-4 py-2 font-mono tabular-nums text-foreground-secondary whitespace-nowrap" style={TNUM}>
                                                        {item.sku}
                                                    </td>
                                                    <td className="px-4 py-2 text-foreground max-w-64 truncate">{item.name}</td>
                                                    <td className="px-4 py-2 text-foreground-secondary">{item.unit}</td>
                                                    <td
                                                        className={`px-4 py-2 font-mono tabular-nums text-right whitespace-nowrap ${
                                                            item.active && (item.onHand <= 0 || isBelowReorder(item))
                                                                ? 'text-warning'
                                                                : 'text-foreground'
                                                        }`}
                                                        style={TNUM}
                                                    >
                                                        {item.active && isBelowReorder(item) && (
                                                            <span
                                                                className="inline-block mr-1.5 px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded-md bg-warning/10 text-warning align-middle"
                                                                title={`At or below reorder point (${formatQty(item.reorderPoint ?? 0)})`}
                                                            >
                                                                Reorder
                                                            </span>
                                                        )}
                                                        {formatQty(item.onHand)}
                                                    </td>
                                                    <td className="px-4 py-2 font-mono tabular-nums text-right text-foreground-secondary whitespace-nowrap" style={TNUM}>
                                                        {formatCurrency(item.avgCost)}
                                                    </td>
                                                    <td className="px-4 py-2 font-mono tabular-nums text-right text-foreground whitespace-nowrap" style={TNUM}>
                                                        {formatCurrency(item.stockValue)}
                                                    </td>
                                                    <td className="px-4 py-2 font-mono tabular-nums text-right text-foreground-secondary whitespace-nowrap" style={TNUM}>
                                                        {item.salePrice != null ? formatCurrency(item.salePrice) : '—'}
                                                    </td>
                                                    <td className="px-4 py-2">
                                                        <ItemStatusBadge active={item.active} />
                                                    </td>
                                                    <td className="px-4 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                                                        <div className="flex justify-end">
                                                            <ActionMenu items={rowActions(item)} label={`Actions for ${item.sku}`} />
                                                        </div>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>

                                {/* Mobile cards */}
                                <div className="md:hidden">
                                    {visibleItems.map((item) => (
                                        <MobileCard
                                            key={item.id}
                                            onClick={() => router.push(`/business/inventory/${item.id}`)}
                                            fields={[
                                                {
                                                    label: 'SKU',
                                                    value: <span className="font-mono tabular-nums" style={TNUM}>{item.sku}</span>,
                                                },
                                                { label: 'Name', value: <span className="truncate">{item.name}</span> },
                                                {
                                                    label: 'On hand',
                                                    value: (
                                                        <span
                                                            className={`font-mono tabular-nums ${
                                                                item.active && (item.onHand <= 0 || isBelowReorder(item)) ? 'text-warning' : ''
                                                            }`}
                                                            style={TNUM}
                                                        >
                                                            {formatQty(item.onHand)} {item.unit}
                                                            {item.active && isBelowReorder(item) ? ' · reorder' : ''}
                                                        </span>
                                                    ),
                                                },
                                                {
                                                    label: 'Stock value',
                                                    value: <span className="font-mono tabular-nums" style={TNUM}>{formatCurrency(item.stockValue)}</span>,
                                                },
                                                { label: 'Status', value: <ItemStatusBadge active={item.active} /> },
                                            ]}
                                        />
                                    ))}
                                </div>
                            </>
                        )}
                    </div>
                </>
            )}

            <ItemFormModal
                editing={editing}
                onClose={() => setEditing(null)}
                onSaved={() => fetchItems()}
            />

            <ConfirmationDialog
                isOpen={!!deactivating}
                onConfirm={handleDeactivate}
                onCancel={() => setDeactivating(null)}
                title="Deactivate Item"
                message={deactivating
                    ? `Deactivate ${deactivating.sku} — ${deactivating.name}? The item is hidden from pickers but its movement history is preserved. You can reactivate it later.`
                    : ''}
                confirmLabel="Deactivate"
                confirmVariant="danger"
                isLoading={isDeactivating}
            />
        </div>
    );
}
