'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { WidgetId } from '@/lib/dashboard-layout';
import {
    CATEGORY_LABELS,
    CATEGORY_ORDER,
    CustomWidgetDef,
    WidgetRegistryEntry,
    availableWidgets,
    describeCustomWidget,
} from '@/lib/dashboard-widgets';

interface WidgetGalleryProps {
    isOpen: boolean;
    onClose: () => void;
    /** Ids currently placed on the dashboard. */
    placedIds: Set<string>;
    isBusiness: boolean;
    customDefs: CustomWidgetDef[];
    onAdd: (id: WidgetId) => void;
    onRemove: (id: WidgetId) => void;
    onNewCustom: () => void;
    onEditCustom: (def: CustomWidgetDef) => void;
    onDeleteCustom: (def: CustomWidgetDef) => void;
}

function AddRemoveButton({
    added,
    onAdd,
    onRemove,
}: {
    added: boolean;
    onAdd: () => void;
    onRemove: () => void;
}) {
    return added ? (
        <button
            onClick={onRemove}
            className="px-2.5 py-1 rounded-lg border border-border text-xs text-foreground-secondary hover:text-negative hover:border-negative/50 transition-colors shrink-0"
        >
            Remove
        </button>
    ) : (
        <button
            onClick={onAdd}
            className="px-2.5 py-1 rounded-lg border border-primary/50 bg-primary/10 text-xs text-primary hover:bg-primary/20 transition-colors shrink-0"
        >
            Add
        </button>
    );
}

/**
 * Modal gallery of all available widgets, grouped by category, with search
 * (`/` focuses it), add/remove toggles, and custom-widget management.
 */
export default function WidgetGallery({
    isOpen,
    onClose,
    placedIds,
    isBusiness,
    customDefs,
    onAdd,
    onRemove,
    onNewCustom,
    onEditCustom,
    onDeleteCustom,
}: WidgetGalleryProps) {
    const [search, setSearch] = useState('');
    const searchRef = useRef<HTMLInputElement>(null);

    // Reset the search each time the gallery opens (derived during render).
    const [wasOpen, setWasOpen] = useState(isOpen);
    if (wasOpen !== isOpen) {
        setWasOpen(isOpen);
        if (isOpen) setSearch('');
    }

    // `/` focuses the search field while the gallery is open.
    useEffect(() => {
        if (!isOpen) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key !== '/') return;
            const target = e.target as HTMLElement | null;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
            e.preventDefault();
            searchRef.current?.focus();
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [isOpen]);

    const q = search.trim().toLowerCase();

    const grouped = useMemo(() => {
        const entries = availableWidgets({ isBusiness }).filter(
            e =>
                !q ||
                e.title.toLowerCase().includes(q) ||
                e.description.toLowerCase().includes(q)
        );
        const byCategory = new Map<string, WidgetRegistryEntry[]>();
        for (const e of entries) {
            const list = byCategory.get(e.category) ?? [];
            list.push(e);
            byCategory.set(e.category, list);
        }
        return byCategory;
    }, [isBusiness, q]);

    const filteredCustom = useMemo(
        () => customDefs.filter(d => !q || d.name.toLowerCase().includes(q)),
        [customDefs, q]
    );

    const nothingMatches =
        q && filteredCustom.length === 0 && CATEGORY_ORDER.every(c => !grouped.get(c)?.length);

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Add widgets" size="lg">
            <div className="p-6 space-y-5">
                {/* Search */}
                <input
                    ref={searchRef}
                    type="text"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search widgets...  ( / )"
                    className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
                />

                {nothingMatches && (
                    <p className="text-sm text-foreground-muted">No widgets match “{search.trim()}”.</p>
                )}

                {/* Built-in widgets by category */}
                {CATEGORY_ORDER.map(category => {
                    const entries = grouped.get(category);
                    if (!entries || entries.length === 0) return null;
                    return (
                        <div key={category}>
                            <h3 className="text-[10px] uppercase tracking-wider text-foreground-muted mb-2">
                                {CATEGORY_LABELS[category]}
                            </h3>
                            <div className="space-y-1.5">
                                {entries.map(entry => {
                                    const added = placedIds.has(entry.id);
                                    return (
                                        <div
                                            key={entry.id}
                                            className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-border bg-surface/50"
                                        >
                                            <div className="min-w-0">
                                                <div className="text-sm text-foreground">
                                                    {entry.title}
                                                    {added && (
                                                        <span className="ml-2 text-[10px] uppercase tracking-wider text-primary">
                                                            Added
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="text-[11px] text-foreground-muted truncate">
                                                    {entry.description}
                                                </div>
                                            </div>
                                            <AddRemoveButton
                                                added={added}
                                                onAdd={() => onAdd(entry.id)}
                                                onRemove={() => onRemove(entry.id)}
                                            />
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}

                {/* Custom widgets */}
                <div>
                    <h3 className="text-[10px] uppercase tracking-wider text-foreground-muted mb-2">
                        Custom
                    </h3>
                    <div className="space-y-1.5">
                        {filteredCustom.map(def => {
                            const added = placedIds.has(def.id);
                            return (
                                <div
                                    key={def.id}
                                    className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-border bg-surface/50"
                                >
                                    <div className="min-w-0">
                                        <div className="text-sm text-foreground">
                                            {def.name}
                                            {added && (
                                                <span className="ml-2 text-[10px] uppercase tracking-wider text-primary">
                                                    Added
                                                </span>
                                            )}
                                        </div>
                                        <div className="text-[11px] text-foreground-muted truncate">
                                            {describeCustomWidget(def)}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0">
                                        <button
                                            onClick={() => onEditCustom(def)}
                                            title="Edit widget"
                                            className="p-1.5 rounded-md text-foreground-muted hover:text-primary hover:bg-surface-hover transition-colors"
                                        >
                                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.862 4.487z" />
                                            </svg>
                                        </button>
                                        <button
                                            onClick={() => onDeleteCustom(def)}
                                            title="Delete widget"
                                            className="p-1.5 rounded-md text-foreground-muted hover:text-negative hover:bg-surface-hover transition-colors"
                                        >
                                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                                            </svg>
                                        </button>
                                        <AddRemoveButton
                                            added={added}
                                            onAdd={() => onAdd(def.id)}
                                            onRemove={() => onRemove(def.id)}
                                        />
                                    </div>
                                </div>
                            );
                        })}
                        <button
                            onClick={onNewCustom}
                            className="w-full text-left px-3 py-2 rounded-lg border border-dashed border-border text-sm text-foreground-secondary hover:border-primary/50 hover:text-primary transition-colors"
                        >
                            + New custom widget…
                        </button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
