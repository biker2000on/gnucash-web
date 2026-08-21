'use client';

import {
    Fragment,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import {
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    getExpandedRowModel,
    getGroupedRowModel,
    getSortedRowModel,
    useReactTable,
    type ExpandedState,
    type SortingState,
} from '@tanstack/react-table';
import type { EntityDocument } from '@/lib/services/entity-documents.service';
import type { DocSearchResults, SearchSnippet } from '@/lib/doc-search';
import { getDocumentTypeLabel, getTaxFormLabel } from '@/lib/entity-document-context';
import { findMissingTaxForms, type MissingTaxForm } from '@/lib/tax-records';
import { ErrorLiveRegion } from '@/components/a11y/LiveRegion';
import { SELECT, inputClass } from '@/components/ui/form';
import { readErrorBody } from '@/lib/api-error';
import { Tip } from '@/components/ui/Tooltip';

// v2: card and table expansion are stored separately (they were one shared
// map in v1, which left the table permanently collapsed — see below).
const STORAGE_KEY = 'documentVault.browser.v2';
const TNUM = { fontFeatureSettings: "'tnum'" } as const;

export type DocumentVaultViewMode = 'cards' | 'table';
export type DocumentVaultGrouping = 'category' | 'taxYear' | 'issuer' | 'none';
export type DocumentThumbnailStatus = 'pending' | 'complete' | 'failed';

/**
 * A vault row as the list endpoint returns it: the entity document plus the
 * sidecars `GET /api/business/documents` already computes in one batched pass
 * (`tags`, `thumbnailStatus`). Reading them here is what keeps the browser
 * from firing one /tags request and one thumbnail request per document.
 */
export interface VaultDocumentRow extends EntityDocument {
    tags?: string[];
    thumbnailStatus?: DocumentThumbnailStatus | null;
}

interface StoredBrowserState {
    viewMode?: DocumentVaultViewMode;
    grouping?: DocumentVaultGrouping;
    sorting?: SortingState;
    /** Collapsed card groups, keyed by group label. */
    cardExpanded?: Record<string, boolean>;
    /** TanStack's own expanded state — never shares a map with the cards. */
    tableExpanded?: ExpandedState;
}

interface SearchHitWithSource {
    id: string;
    title: string;
    href: string;
    date?: string | null;
    snippet: SearchSnippet;
    sourceId?: string | null;
    sourceKind?: string;
}

interface VaultRow extends VaultDocumentRow {
    categoryLabel: string;
    groupCategory: string;
    taxYearGroup: string;
    issuerGroup: string;
    fileType: string;
    searchSnippet?: SearchSnippet;
}

export interface DocumentVaultBrowserProps {
    documents: VaultDocumentRow[];
    categoryOptions: Array<{ value: string; label: string }>;
    onPreview: (document: EntityDocument) => void;
    onEdit: (document: EntityDocument) => void;
    onDelete: (documentId: number) => void;
    editingId?: number | null;
    confirmDeleteId?: number | null;
    onRequestDelete: (documentId: number | null) => void;
    renderEditor?: (document: EntityDocument) => ReactNode;
}

function isViewMode(value: unknown): value is DocumentVaultViewMode {
    return value === 'cards' || value === 'table';
}

function isGrouping(value: unknown): value is DocumentVaultGrouping {
    return value === 'category' || value === 'taxYear' || value === 'issuer' || value === 'none';
}

/** TanStack accepts `true` (all expanded) or a record of row-id booleans. */
function isExpandedState(value: unknown): value is ExpandedState {
    if (value === true) return true;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'boolean');
}

function isSortingState(value: unknown): value is SortingState {
    return Array.isArray(value) && value.every((entry) =>
        typeof entry === 'object' && entry !== null
        && typeof (entry as { id?: unknown }).id === 'string'
        && typeof (entry as { desc?: unknown }).desc === 'boolean'
    );
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'boolean');
}

/**
 * Read persisted preferences. Called from an effect, never during render:
 * touching localStorage while rendering makes the server-rendered markup and
 * the client's first paint disagree (hydration mismatch).
 */
function loadStoredState(): StoredBrowserState {
    if (typeof window === 'undefined') return {};
    try {
        const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown;
        if (typeof parsed !== 'object' || parsed === null) return {};
        const raw = parsed as Record<string, unknown>;
        return {
            viewMode: isViewMode(raw.viewMode) ? raw.viewMode : undefined,
            grouping: isGrouping(raw.grouping) ? raw.grouping : undefined,
            sorting: isSortingState(raw.sorting) ? raw.sorting : undefined,
            cardExpanded: isBooleanRecord(raw.cardExpanded) ? raw.cardExpanded : undefined,
            tableExpanded: isExpandedState(raw.tableExpanded) ? raw.tableExpanded : undefined,
        };
    } catch {
        return {};
    }
}

export function formatDocumentBytes(bytes: number | null): string {
    if (bytes === null) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileTypeLabel(document: EntityDocument): string {
    if (document.mimeType === 'application/pdf') return 'PDF';
    if (document.mimeType?.startsWith('image/')) {
        return document.mimeType.slice('image/'.length).toUpperCase();
    }
    const extension = document.fileName?.split('.').pop();
    return extension ? extension.toUpperCase() : '—';
}

function categoryGroupLabel(document: EntityDocument, categoryLabel: string): string {
    if (document.docType !== 'tax') return categoryLabel;
    return `${categoryLabel} · ${document.taxYear ?? 'No tax year set'}`;
}

function HighlightedSnippet({ snippet }: { snippet: SearchSnippet }) {
    if (snippet.highlightStart < 0 || snippet.highlightEnd <= snippet.highlightStart) {
        return <>{snippet.text}</>;
    }
    return (
        <>
            {snippet.text.slice(0, snippet.highlightStart)}
            <mark className="bg-warning/20 text-foreground">
                {snippet.text.slice(snippet.highlightStart, snippet.highlightEnd)}
            </mark>
            {snippet.text.slice(snippet.highlightEnd)}
        </>
    );
}

/**
 * Renders the stored first-page thumbnail.
 *
 * The fetch is issued ONLY for `thumbnailStatus === 'complete'`. The status
 * arrives with the list response, so a vault of N documents no longer fires N
 * requests that mostly 404: pending and failed rows render their own state
 * without touching the network, and they render *different* states — a failed
 * render is terminal, and showing it as "Preview pending" forever was a lie.
 */
/**
 * At most this many thumbnail requests in flight at once. The vault used to
 * fire one unbounded fetch per card on mount — N concurrent storage reads on a
 * pool prone to IO storms, which is exactly the load that made the preview's
 * own reads stall (2026-08-21 review, F2).
 */
const THUMBNAIL_MAX_CONCURRENT = 6;
let thumbnailInFlight = 0;
const thumbnailWaiters: Array<() => void> = [];

async function acquireThumbnailSlot(): Promise<() => void> {
    if (thumbnailInFlight >= THUMBNAIL_MAX_CONCURRENT) {
        await new Promise<void>((resolve) => thumbnailWaiters.push(resolve));
    }
    thumbnailInFlight += 1;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        thumbnailInFlight -= 1;
        thumbnailWaiters.shift()?.();
    };
}

function DocumentThumbnail({ document }: { document: VaultDocumentRow }) {
    const [src, setSrc] = useState<string | null>(null);
    const [nearViewport, setNearViewport] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const status = document.thumbnailStatus;
    const shouldFetch = status === 'complete' && nearViewport;

    // Fetch only when the card is on (or near) screen; a multi-year archive
    // must not fire hundreds of storage reads for rows nobody scrolled to.
    useEffect(() => {
        const el = rootRef.current;
        if (!el || nearViewport) return;
        if (typeof IntersectionObserver !== 'function') {
            setNearViewport(true);
            return;
        }
        const observer = new IntersectionObserver((entries) => {
            if (entries.some(entry => entry.isIntersecting)) setNearViewport(true);
        }, { rootMargin: '400px' });
        observer.observe(el);
        return () => observer.disconnect();
    }, [nearViewport]);

    useEffect(() => {
        if (!shouldFetch) return;
        let cancelled = false;
        let objectUrl: string | null = null;
        const controller = new AbortController();
        let release: (() => void) | null = null;

        void (async () => {
            try {
                release = await acquireThumbnailSlot();
                if (cancelled) return;
                const response = await fetch(`/api/business/documents/${document.id}/thumbnail`, {
                    signal: controller.signal,
                });
                if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'image/webp') {
                    return;
                }
                const blob = await response.blob();
                if (cancelled || typeof URL.createObjectURL !== 'function') return;
                objectUrl = URL.createObjectURL(blob);
                setSrc(objectUrl);
            } catch {
                // A thumbnail that disappeared between list and fetch falls back
                // to the placeholder rather than breaking the card.
            } finally {
                release?.();
            }
        })();

        return () => {
            cancelled = true;
            controller.abort();
            release?.();
            if (objectUrl && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(objectUrl);
        };
    }, [document.id, shouldFetch]);

    return (
        <div ref={rootRef} className="flex aspect-[4/3] items-center justify-center overflow-hidden border-b border-border bg-background-tertiary">
            {shouldFetch && src ? (
                // The byte route is accepted only after its image/webp response is verified above.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={src} alt={`First page of ${document.title}`} className="h-full w-full object-cover" />
            ) : status === 'failed' ? (
                <div
                    className="flex flex-col items-center gap-2 text-foreground-muted"
                    data-testid={`thumbnail-failed-${document.id}`}
                >
                    <span aria-hidden="true" className="font-mono text-2xl">▧</span>
                    <span className="text-xs">No preview</span>
                </div>
            ) : (
                <div
                    className="flex flex-col items-center gap-2 text-foreground-muted"
                    data-testid={`thumbnail-placeholder-${document.id}`}
                >
                    <span aria-hidden="true" className="font-mono text-2xl">▤</span>
                    <span className="text-xs">Preview pending</span>
                </div>
            )}
        </div>
    );
}

function ExpiryText({ document }: { document: EntityDocument }) {
    if (!document.expiresOn) return <span className="text-foreground-muted">—</span>;
    const state = document.daysUntilExpiry;
    const className = state !== null && state < 0
        ? 'text-error'
        : state !== null && state <= 60
          ? 'text-warning'
          : 'text-foreground-secondary';
    return <span className={className}>{document.expiresOn}</span>;
}

/** Relative expiry pill ("Expires in 12d" / "Expired 5d ago") — restored. */
function ExpiryPill({ document }: { document: EntityDocument }) {
    if (!document.expiresOn || document.daysUntilExpiry === null) return null;
    const days = document.daysUntilExpiry;
    const label = days < 0
        ? `Expired ${Math.abs(days)}d ago`
        : days === 0
          ? 'Expires today'
          : `Expires in ${days}d`;
    const tone = days < 0
        ? 'border-error/40 bg-error/10 text-error'
        : days <= 60
          ? 'border-warning/40 bg-warning/10 text-warning'
          : 'border-border bg-background-tertiary text-foreground-secondary';
    return (
        <Tip content={`Expires ${document.expiresOn}`}>
        <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] ${tone}`}>
            {label}
        </span>
        </Tip>
    );
}

function TagChips({ tags }: { tags: string[] | undefined }) {
    if (!tags?.length) return null;
    return (
        <span className="flex flex-wrap gap-1">
            {tags.map((tag) => (
                <span key={tag} className="rounded-full border border-primary/30 bg-primary-light px-2 py-0.5 text-[11px] text-primary">
                    {tag}
                </span>
            ))}
        </span>
    );
}

/** Missing prior-year tax forms, rendered in BOTH views and under any grouping. */
function MissingTaxFormsNotice({ entries, className }: { entries: MissingTaxForm[]; className?: string }) {
    if (entries.length === 0) return null;
    const byYear = new Map<number, MissingTaxForm[]>();
    for (const entry of entries) {
        byYear.set(entry.year, [...(byYear.get(entry.year) ?? []), entry]);
    }
    return (
        <div
            className={`rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning ${className ?? ''}`}
            data-testid="missing-tax-forms"
        >
            {[...byYear.entries()]
                .sort(([a], [b]) => b - a)
                .map(([year, yearEntries]) => (
                    <p key={year}>
                        Missing vs {year - 1}: {yearEntries.map((entry) => entry.label).join(', ')}
                    </p>
                ))}
        </div>
    );
}

function TagEditor({
    document,
    tags,
    vocabulary,
    onSaved,
}: {
    document: EntityDocument;
    tags: string[];
    vocabulary: string[];
    onSaved: (tags: string[]) => void;
}) {
    const [open, setOpen] = useState(false);
    const [value, setValue] = useState(tags.join(', '));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);

    // Depend on the tag CONTENT, not the array identity: a parent re-render
    // handing over a fresh `[]` would otherwise wipe the user's draft mid-edit.
    const tagsKey = tags.join('\u0000');
    useEffect(() => {
        setValue(tagsKey.split('\u0000').filter(Boolean).join(', '));
    }, [tagsKey, document.id]);

    const close = useCallback(() => {
        setOpen(false);
        triggerRef.current?.focus();
    }, []);

    // Dialog semantics: focus moves in on open, Escape closes, outside click closes.
    useEffect(() => {
        if (!open) return;
        inputRef.current?.focus();
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                close();
            }
        };
        const onPointerDown = (event: MouseEvent) => {
            const target = event.target as Node | null;
            if (!target) return;
            if (dialogRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
            setOpen(false);
        };
        window.document.addEventListener('keydown', onKeyDown, true);
        window.document.addEventListener('mousedown', onPointerDown);
        return () => {
            window.document.removeEventListener('keydown', onKeyDown, true);
            window.document.removeEventListener('mousedown', onPointerDown);
        };
    }, [close, open]);

    const toggleVocabularyTag = (tag: string) => {
        const next = new Set(value.split(',').map((part) => part.trim()).filter(Boolean));
        if (next.has(tag)) next.delete(tag);
        else next.add(tag);
        setValue([...next].sort((a, b) => a.localeCompare(b)).join(', '));
    };

    const save = async () => {
        const next = [...new Set(value.split(',').map((part) => part.trim()).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b));
        setSaving(true);
        setError(null);
        try {
            const response = await fetch(`/api/business/documents/${document.id}/tags`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tags: next }),
            });
            if (!response.ok) throw new Error(await readErrorBody(response, 'Failed to save tags'));
            const body = await response.json().catch(() => ({ tags: next })) as { tags?: string[] };
            onSaved(Array.isArray(body.tags) ? body.tags : next);
            close();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Failed to save tags');
        } finally {
            setSaving(false);
        }
    };

    return (
        <span className="relative">
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen((current) => !current)}
                aria-expanded={open}
                aria-haspopup="dialog"
                className="text-xs text-foreground-muted transition-colors hover:text-primary"
            >
                Edit tags
            </button>
            {open && (
                <div
                    ref={dialogRef}
                    role="dialog"
                    aria-modal="false"
                    aria-label={`Edit tags for ${document.title}`}
                    className="absolute right-0 top-7 z-20 w-72 space-y-3 rounded-md border border-border bg-surface-elevated p-3 text-left shadow-lg"
                >
                    <label className="block text-xs font-medium text-foreground-secondary">
                        Tags, separated by commas
                        <input
                            ref={inputRef}
                            value={value}
                            onChange={(event) => setValue(event.target.value)}
                            className={inputClass({ extra: 'mt-1' })}
                        />
                    </label>
                    {vocabulary.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                            {vocabulary.map((tag) => {
                                const selected = value.split(',').map((part) => part.trim()).includes(tag);
                                return (
                                    <button
                                        key={tag}
                                        type="button"
                                        aria-pressed={selected}
                                        onClick={() => toggleVocabularyTag(tag)}
                                        className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${selected ? 'border-primary bg-primary-light text-primary' : 'border-border text-foreground-secondary hover:border-border-hover'}`}
                                    >
                                        {tag}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                    {error && <span className="block text-xs text-error">{error}</span>}
                    <div className="flex justify-end gap-2">
                        <button type="button" onClick={close} className="text-xs text-foreground-secondary hover:text-foreground">Cancel</button>
                        <button type="button" onClick={save} disabled={saving} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50">
                            {saving ? 'Saving…' : 'Save tags'}
                        </button>
                    </div>
                    <ErrorLiveRegion message={error} />
                </div>
            )}
        </span>
    );
}

function DocumentActions({
    document,
    tags,
    vocabulary,
    tagsAvailable,
    confirmDelete,
    onPreview,
    onEdit,
    onRequestDelete,
    onDelete,
    onTagsSaved,
}: {
    document: EntityDocument;
    tags: string[] | undefined;
    vocabulary: string[];
    tagsAvailable: boolean;
    confirmDelete: boolean;
    onPreview: () => void;
    onEdit: () => void;
    onRequestDelete: (id: number | null) => void;
    onDelete: () => void;
    onTagsSaved: (tags: string[]) => void;
}) {
    return (
        <span className="flex flex-wrap items-center gap-3 text-xs">
            <button type="button" onClick={onPreview} className="text-primary hover:text-primary-hover">Preview</button>
            <a href={`/api/business/documents/${document.id}/download`} className="text-foreground-secondary hover:text-foreground">Download</a>
            <button type="button" onClick={onEdit} className="text-foreground-secondary hover:text-foreground">Edit</button>
            {tagsAvailable && (
                <TagEditor document={document} tags={tags ?? []} vocabulary={vocabulary} onSaved={onTagsSaved} />
            )}
            {confirmDelete ? (
                <span className="flex items-center gap-2">
                    <button type="button" onClick={onDelete} className="font-medium text-error hover:opacity-80">Confirm delete</button>
                    <button type="button" onClick={() => onRequestDelete(null)} className="text-foreground-muted hover:text-foreground">Cancel</button>
                </span>
            ) : (
                <button type="button" onClick={() => onRequestDelete(document.id)} className="text-foreground-muted hover:text-error">Delete</button>
            )}
        </span>
    );
}

const columnHelper = createColumnHelper<VaultRow>();

export function DocumentVaultBrowser({
    documents,
    categoryOptions,
    onPreview,
    onEdit,
    onDelete,
    editingId,
    confirmDeleteId,
    onRequestDelete,
    renderEditor,
}: DocumentVaultBrowserProps) {
    // Defaults only during the first render so SSR and hydration agree; the
    // persisted preferences land in the effect below.
    const [viewMode, setViewMode] = useState<DocumentVaultViewMode>('cards');
    const [grouping, setGrouping] = useState<DocumentVaultGrouping>('category');
    const [sorting, setSorting] = useState<SortingState>([{ id: 'title', desc: false }]);
    const [cardExpanded, setCardExpanded] = useState<Record<string, boolean>>({});
    const [tableExpanded, setTableExpanded] = useState<ExpandedState>(true);
    const [hydrated, setHydrated] = useState(false);
    const [query, setQuery] = useState('');
    const [category, setCategory] = useState('all');
    const [searchHits, setSearchHits] = useState<SearchHitWithSource[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [tagOverrides, setTagOverrides] = useState<Record<number, string[]>>({});
    const [tagVocabulary, setTagVocabulary] = useState<Array<{ name: string; count: number }>>([]);
    const [tagsAvailable, setTagsAvailable] = useState(false);
    const [selectedTags, setSelectedTags] = useState<string[]>([]);

    useEffect(() => {
        const stored = loadStoredState();
        if (stored.viewMode) setViewMode(stored.viewMode);
        if (stored.grouping) setGrouping(stored.grouping);
        if (stored.sorting) setSorting(stored.sorting);
        if (stored.cardExpanded) setCardExpanded(stored.cardExpanded);
        if (stored.tableExpanded !== undefined) setTableExpanded(stored.tableExpanded);
        setHydrated(true);
    }, []);

    useEffect(() => {
        if (!hydrated) return;
        window.localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ viewMode, grouping, sorting, cardExpanded, tableExpanded }),
        );
    }, [cardExpanded, grouping, hydrated, sorting, tableExpanded, viewMode]);

    /**
     * Tags come from the list response's `tags` sidecar. `tagOverrides` only
     * holds documents edited during this session, so a save shows immediately
     * without re-reading the whole vault — and the browser issues ZERO
     * per-document tag requests on load (it used to issue one each).
     */
    const tagsByDocument = useMemo(() => {
        const map: Record<number, string[]> = {};
        for (const document of documents) {
            map[document.id] = tagOverrides[document.id] ?? document.tags ?? [];
        }
        return map;
    }, [documents, tagOverrides]);

    const refreshVocabulary = useCallback(async (signal?: AbortSignal) => {
        try {
            const response = await fetch('/api/business/documents/tags', { signal });
            if (!response.ok) return false;
            const body = await response.json() as { tags?: Array<{ name: string; count: number }> };
            if (!Array.isArray(body.tags)) return false;
            setTagVocabulary(body.tags);
            setTagsAvailable(true);
            return true;
        } catch {
            // A vault deployed before the tag routes simply hides all tag controls.
            return false;
        }
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        void refreshVocabulary(controller.signal);
        return () => controller.abort();
    }, [refreshVocabulary]);

    /** After a save: adopt the new tags AND refresh vocabulary chips/counts. */
    const handleTagsSaved = useCallback(async (documentId: number, tags: string[]) => {
        setTagOverrides((current) => ({ ...current, [documentId]: tags }));
        await refreshVocabulary();
        try {
            const response = await fetch(`/api/business/documents/${documentId}/tags`);
            if (!response.ok) return;
            const body = await response.json() as { tags?: string[] };
            if (Array.isArray(body.tags)) {
                setTagOverrides((current) => ({ ...current, [documentId]: body.tags! }));
            }
        } catch {
            // The optimistic value from the PUT response stands.
        }
    }, [refreshVocabulary]);

    useEffect(() => {
        const trimmed = query.trim();
        if (trimmed.length < 3) {
            setSearchHits(null);
            setSearchError(null);
            setSearching(false);
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => {
            setSearching(true);
            setSearchError(null);
            void fetch(`/api/search/documents?q=${encodeURIComponent(trimmed)}&limit=20`, { signal: controller.signal })
                .then(async (response) => {
                    if (!response.ok) throw new Error(await readErrorBody(response, 'Document search failed'));
                    return response.json() as Promise<DocSearchResults>;
                })
                .then((body) => {
                    const hits = (body.documents ?? []) as SearchHitWithSource[];
                    setSearchHits(hits.filter((hit) =>
                        hit.sourceKind ? hit.sourceKind === 'entity_document' : hit.href === '/business/documents'
                    ));
                })
                .catch((caught: unknown) => {
                    if (caught instanceof DOMException && caught.name === 'AbortError') return;
                    setSearchHits([]);
                    setSearchError(caught instanceof Error ? caught.message : 'Document search failed');
                })
                .finally(() => setSearching(false));
        }, 250);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [query]);

    const categoryLabels = useMemo(() => new Map(categoryOptions.map((option) => [option.value, option.label])), [categoryOptions]);

    const rows = useMemo<VaultRow[]>(() => {
        const hitsByDocument = new Map<number, SearchSnippet>();
        const matchedIds = new Set<number>();
        if (searchHits) {
            const byEntityId = new Map(documents.map((document) => [document.id, document]));
            const byCanonicalId = new Map(
                documents
                    .filter((document) => document.canonicalDocumentId !== undefined)
                    .map((document) => [document.canonicalDocumentId!, document]),
            );
            for (const hit of searchHits) {
                /*
                 * Resolution order matters. `hit.id` is a CANONICAL document id
                 * and `document.id` is an entity-document id — different key
                 * spaces that collide, so matching a canonical id against an
                 * entity id (or, worse, falling through to title/date) could
                 * attach a snippet to, and let the UI act on, the wrong file.
                 * `sourceId` is the authoritative link; the canonical-id map is
                 * the fallback; title/date is a last resort for old servers
                 * that send neither.
                 */
                const sourceId = hit.sourceId != null ? Number(hit.sourceId) : NaN;
                let document = Number.isInteger(sourceId) ? byEntityId.get(sourceId) : undefined;
                document ??= byCanonicalId.get(Number(hit.id));
                if (!document && hit.sourceId == null) {
                    const titleMatches = documents.filter((candidate) =>
                        candidate.title === hit.title && !matchedIds.has(candidate.id)
                    );
                    document = titleMatches.find((candidate) =>
                        hit.date && candidate.uploadedAt.slice(0, 10) === hit.date
                    ) ?? titleMatches[0];
                }
                if (!document) continue;
                matchedIds.add(document.id);
                hitsByDocument.set(document.id, hit.snippet);
            }
        }

        return documents
            .filter((document) => !searchHits || matchedIds.has(document.id))
            .filter((document) => category === 'all' || document.docType === category)
            .filter((document) => selectedTags.every((tag) => tagsByDocument[document.id]?.includes(tag)))
            .map((document) => {
                const categoryLabel = categoryLabels.get(document.docType) ?? getDocumentTypeLabel(document.docType);
                return {
                    ...document,
                    categoryLabel,
                    groupCategory: categoryLabels.has(document.docType)
                        ? categoryGroupLabel(document, categoryLabel)
                        : 'Other document types',
                    taxYearGroup: document.taxYear === null ? 'No tax year set' : String(document.taxYear),
                    issuerGroup: document.issuer?.trim() || 'No issuer set',
                    fileType: fileTypeLabel(document),
                    searchSnippet: hitsByDocument.get(document.id),
                };
            });
    }, [category, categoryLabels, documents, searchHits, selectedTags, tagsByDocument]);

    const columns = useMemo(() => [
        columnHelper.accessor('groupCategory', { id: 'groupCategory', header: 'Category group' }),
        columnHelper.accessor('taxYearGroup', { id: 'taxYearGroup', header: 'Tax year group' }),
        columnHelper.accessor('issuerGroup', { id: 'issuerGroup', header: 'Issuer group' }),
        columnHelper.accessor('title', {
            header: 'Title',
            cell: ({ row }) => (
                <span className="block min-w-48">
                    <button type="button" onClick={() => onPreview(row.original)} className="text-left font-medium text-foreground hover:text-primary">
                        {row.original.title}
                    </button>
                    {row.original.searchSnippet && (
                        <span className="mt-1 block max-w-md text-xs font-normal text-foreground-muted">
                            <HighlightedSnippet snippet={row.original.searchSnippet} />
                        </span>
                    )}
                    {row.original.notes && (
                        <Tip content={row.original.notes}><span className="mt-1 block max-w-md truncate text-xs font-normal text-foreground-muted">
                            {row.original.notes}
                        </span></Tip>
                    )}
                    <span className="mt-1 block"><TagChips tags={tagsByDocument[row.original.id]} /></span>
                </span>
            ),
        }),
        columnHelper.accessor('fileName', {
            id: 'fileName',
            header: 'File',
            cell: ({ getValue }) => (
                <Tip content={getValue() ?? ''}><span className="block max-w-56 truncate font-mono text-xs" style={TNUM}>
                    {getValue() || '—'}
                </span></Tip>
            ),
        }),
        columnHelper.accessor('categoryLabel', {
            id: 'category',
            header: 'Category',
            cell: ({ getValue }) => <span className="rounded-full border border-border bg-background-tertiary px-2 py-0.5 text-[11px] text-foreground-secondary">{getValue()}</span>,
        }),
        columnHelper.accessor('issuer', { header: 'Issuer', cell: ({ getValue }) => getValue() || '—' }),
        columnHelper.accessor('issuedOn', { header: 'Issued', cell: ({ getValue }) => getValue() || '—' }),
        columnHelper.accessor('expiresOn', {
            header: 'Expires',
            cell: ({ row }) => <ExpiryText document={row.original} />,
        }),
        columnHelper.accessor('sizeBytes', {
            header: 'Size',
            cell: ({ getValue }) => formatDocumentBytes(getValue()),
        }),
        columnHelper.accessor('fileType', { id: 'type', header: 'Type' }),
        columnHelper.display({
            id: 'actions',
            header: 'Actions',
            enableSorting: false,
            cell: ({ row }) => (
                <DocumentActions
                    document={row.original}
                    tags={tagsByDocument[row.original.id]}
                    vocabulary={tagVocabulary.map((tag) => tag.name)}
                    tagsAvailable={tagsAvailable}
                    confirmDelete={confirmDeleteId === row.original.id}
                    onPreview={() => onPreview(row.original)}
                    onEdit={() => onEdit(row.original)}
                    onRequestDelete={onRequestDelete}
                    onDelete={() => onDelete(row.original.id)}
                    onTagsSaved={(tags) => void handleTagsSaved(row.original.id, tags)}
                />
            ),
        }),
    ], [confirmDeleteId, handleTagsSaved, onDelete, onEdit, onPreview, onRequestDelete, tagVocabulary, tagsAvailable, tagsByDocument]);

    const tableGrouping = grouping === 'category'
        ? ['groupCategory']
        : grouping === 'taxYear'
          ? ['taxYearGroup']
          : grouping === 'issuer'
            ? ['issuerGroup']
            : [];

    const table = useReactTable({
        data: rows,
        columns,
        state: {
            sorting,
            // Card collapse state must NEVER reach TanStack: it reads a record
            // as "only these row ids are expanded", so a single collapsed card
            // group used to render every table group empty (and persist it).
            expanded: tableExpanded,
            grouping: tableGrouping,
            columnVisibility: { groupCategory: false, taxYearGroup: false, issuerGroup: false },
        },
        onSortingChange: setSorting,
        onExpandedChange: setTableExpanded,
        autoResetExpanded: false,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getGroupedRowModel: getGroupedRowModel(),
        getExpandedRowModel: getExpandedRowModel(),
        getRowId: (row) => String(row.id),
    });

    const sortedRows = table.getSortedRowModel().flatRows.filter((row) => !row.getIsGrouped()).map((row) => row.original);
    const cardGroups = useMemo(() => {
        if (grouping === 'none') return [{ key: 'all', label: 'All documents', documents: sortedRows }];
        const groups = new Map<string, VaultRow[]>();
        for (const row of sortedRows) {
            const label = grouping === 'category'
                ? row.groupCategory
                : grouping === 'taxYear'
                  ? row.taxYearGroup
                  : row.issuerGroup;
            groups.set(label, [...(groups.get(label) ?? []), row]);
        }
        return [...groups.entries()].map(([label, groupedDocuments]) => ({ key: label, label, documents: groupedDocuments }));
    }, [grouping, sortedRows]);

    /**
     * The prior-year completeness diff is derived from the tax records
     * themselves, not from a group label that happens to parse as a year — the
     * label-parse version only ever fired under "Group by → Tax year" and was
     * invisible in table view.
     */
    const missingTaxForms = useMemo(() => findMissingTaxForms(documents), [documents]);
    const missingByYear = useMemo(() => {
        const map = new Map<number, MissingTaxForm[]>();
        for (const entry of missingTaxForms) {
            map.set(entry.year, [...(map.get(entry.year) ?? []), entry]);
        }
        return map;
    }, [missingTaxForms]);

    const missingForGroup = useCallback((groupDocuments: VaultRow[]): MissingTaxForm[] => {
        const years = new Set(
            groupDocuments
                .filter((row) => row.docType === 'tax' && row.taxYear !== null)
                .map((row) => row.taxYear as number),
        );
        return [...years].flatMap((year) => missingByYear.get(year) ?? []);
    }, [missingByYear]);

    const updateCardExpanded = useCallback((key: string) => {
        setCardExpanded((current) => ({ ...current, [key]: current[key] === false }));
    }, []);

    const isCardExpanded = (key: string) => cardExpanded[key] !== false;
    const visibleCategoryOptions = [
        ...categoryOptions,
        ...documents
            .filter((document, index, all) =>
                !categoryLabels.has(document.docType)
                && all.findIndex((candidate) => candidate.docType === document.docType) === index
            )
            .map((document) => ({
                value: document.docType,
                label: getDocumentTypeLabel(document.docType),
            })),
    ];

    return (
        <section className="space-y-4" aria-label="Document browser">
            {/* Preload the pdf.js runtime so a Preview click does not pay the
                module download on the critical path (React hoists this link). */}
            <link rel="modulepreload" href="/pdf.min.mjs" />
            <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-background-secondary/30 p-3">
                <label className="min-w-64 flex-1 text-xs font-medium text-foreground-secondary">
                    Search document text
                    <input
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search titles and document text…"
                        className={inputClass({ extra: 'mt-1' })}
                    />
                </label>
                <label className="text-xs font-medium text-foreground-secondary">
                    Category
                    <select value={category} onChange={(event) => setCategory(event.target.value)} className={`${SELECT} mt-1 min-w-44`}>
                        <option value="all">All categories</option>
                        {visibleCategoryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                </label>
                <label className="text-xs font-medium text-foreground-secondary">
                    Group by
                    <select
                        value={grouping}
                        onChange={(event) => setGrouping(event.target.value as DocumentVaultGrouping)}
                        className={`${SELECT} mt-1 min-w-36`}
                    >
                        <option value="category">Category</option>
                        <option value="taxYear">Tax year</option>
                        <option value="issuer">Issuer</option>
                        <option value="none">None</option>
                    </select>
                </label>
                <span className="flex rounded-md border border-border p-0.5" aria-label="View mode">
                    {(['cards', 'table'] as const).map((mode) => (
                        <button
                            key={mode}
                            type="button"
                            aria-pressed={viewMode === mode}
                            onClick={() => setViewMode(mode)}
                            className={`rounded-sm px-3 py-2 text-xs font-medium capitalize ${viewMode === mode ? 'bg-primary text-primary-foreground' : 'text-foreground-secondary hover:text-foreground'}`}
                        >
                            {mode}
                        </button>
                    ))}
                </span>
            </div>

            {tagsAvailable && tagVocabulary.length > 0 && (
                <div className="flex flex-wrap items-center gap-2" aria-label="Filter by tags">
                    <span className="text-xs text-foreground-muted">Tags</span>
                    {tagVocabulary.map((tag) => {
                        const selected = selectedTags.includes(tag.name);
                        return (
                            <button
                                key={tag.name}
                                type="button"
                                aria-pressed={selected}
                                onClick={() => setSelectedTags((current) => selected ? current.filter((name) => name !== tag.name) : [...current, tag.name])}
                                className={`rounded-full border px-2 py-1 text-xs ${selected ? 'border-primary bg-primary-light text-primary' : 'border-border text-foreground-secondary hover:border-border-hover'}`}
                            >
                                {tag.name} <span className="font-mono text-[11px]" style={TNUM}>{tag.count}</span>
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Rendered in both views and under every grouping. */}
            <MissingTaxFormsNotice entries={missingTaxForms} />

            <div className="flex items-center justify-between gap-3 text-xs text-foreground-muted">
                <span className="font-mono" style={TNUM}>{rows.length} document{rows.length === 1 ? '' : 's'}</span>
                {searching && <span>Searching…</span>}
                {query.trim().length > 0 && query.trim().length < 3 && <span>Enter at least 3 characters to search document text.</span>}
                {searchError && <span className="text-error">{searchError}</span>}
            </div>
            <ErrorLiveRegion message={searchError} />

            {rows.length === 0 ? (
                <div className="rounded-lg border border-border bg-background-secondary/30 p-8 text-center text-sm text-foreground-secondary">
                    {query.trim().length >= 3 || category !== 'all' || selectedTags.length > 0
                        ? 'No documents match these filters.'
                        : 'No documents yet.'}
                </div>
            ) : viewMode === 'cards' ? (
                <div className="space-y-4" data-testid="document-card-view">
                    {cardGroups.map((group) => {
                        const open = isCardExpanded(group.key);
                        const missing = missingForGroup(group.documents);
                        return (
                            <section key={group.key} className="overflow-hidden rounded-lg border border-border bg-background-secondary/30">
                                {grouping !== 'none' && (
                                    <button
                                        type="button"
                                        aria-expanded={open}
                                        onClick={() => updateCardExpanded(group.key)}
                                        className="flex w-full flex-wrap items-center gap-3 border-b border-border px-4 py-2.5 text-left hover:bg-surface-hover"
                                    >
                                        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
                                        <span className="text-xs font-semibold uppercase tracking-wider text-foreground-secondary">{group.label}</span>
                                        <span className="font-mono text-xs text-foreground-muted" style={TNUM}>{group.documents.length}</span>
                                        {missing.length > 0 && (
                                            <span className="text-xs text-warning">
                                                Missing vs {missing[0].priorYear}: {missing.map((entry) => entry.label).join(', ')}
                                            </span>
                                        )}
                                    </button>
                                )}
                                {open && (
                                    <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                                        {group.documents.map((document) => (
                                            <Fragment key={document.id}>
                                                <article className="overflow-hidden rounded-lg border border-border bg-surface">
                                                    <DocumentThumbnail document={document} />
                                                    <div className="space-y-3 p-3">
                                                        <div className="flex items-start justify-between gap-2">
                                                            <button type="button" onClick={() => onPreview(document)} className="text-left text-sm font-semibold text-foreground hover:text-primary">
                                                                {document.title}
                                                            </button>
                                                            <span className="shrink-0 rounded-full border border-border bg-background-tertiary px-2 py-0.5 text-[11px] text-foreground-secondary">{document.categoryLabel}</span>
                                                        </div>
                                                        <div className="space-y-1 font-mono text-xs text-foreground-muted" style={TNUM}>
                                                            <p>{document.issuedOn ?? document.uploadedAt.slice(0, 10)} · {formatDocumentBytes(document.sizeBytes)} · {document.fileType}</p>
                                                            {document.fileName && (
                                                                <Tip content={document.fileName}><p className="truncate">{document.fileName}</p></Tip>
                                                            )}
                                                            {document.docType === 'tax' && (document.taxForm || document.issuer) && (
                                                                <p>{[getTaxFormLabel(document.taxForm), document.issuer].filter(Boolean).join(' · ')}</p>
                                                            )}
                                                        </div>
                                                        <ExpiryPill document={document} />
                                                        {document.notes && (
                                                            <Tip content={document.notes}><p className="line-clamp-2 text-xs text-foreground-secondary">{document.notes}</p></Tip>
                                                        )}
                                                        {document.searchSnippet && <p className="text-xs text-foreground-muted"><HighlightedSnippet snippet={document.searchSnippet} /></p>}
                                                        <TagChips tags={tagsByDocument[document.id]} />
                                                        <DocumentActions
                                                            document={document}
                                                            tags={tagsByDocument[document.id]}
                                                            vocabulary={tagVocabulary.map((tag) => tag.name)}
                                                            tagsAvailable={tagsAvailable}
                                                            confirmDelete={confirmDeleteId === document.id}
                                                            onPreview={() => onPreview(document)}
                                                            onEdit={() => onEdit(document)}
                                                            onRequestDelete={onRequestDelete}
                                                            onDelete={() => onDelete(document.id)}
                                                            onTagsSaved={(tags) => void handleTagsSaved(document.id, tags)}
                                                        />
                                                    </div>
                                                </article>
                                                {editingId === document.id && renderEditor?.(document)}
                                            </Fragment>
                                        ))}
                                    </div>
                                )}
                            </section>
                        );
                    })}
                </div>
            ) : (
                <div className="overflow-x-auto rounded-lg border border-border bg-background-secondary/30" data-testid="document-table-view">
                    <table className="w-full border-collapse text-sm">
                        <thead>
                            {table.getHeaderGroups().map((headerGroup) => (
                                <tr key={headerGroup.id} className="border-b border-border bg-background-tertiary/40">
                                    {headerGroup.headers.map((header) => (
                                        <th key={header.id} scope="col" className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                                            {header.isPlaceholder ? null : (
                                                <button
                                                    type="button"
                                                    disabled={!header.column.getCanSort()}
                                                    onClick={header.column.getToggleSortingHandler()}
                                                    className="flex items-center gap-1 disabled:cursor-default"
                                                >
                                                    {flexRender(header.column.columnDef.header, header.getContext())}
                                                    {{ asc: '↑', desc: '↓' }[header.column.getIsSorted() as string] ?? ''}
                                                </button>
                                            )}
                                        </th>
                                    ))}
                                </tr>
                            ))}
                        </thead>
                        <tbody>
                            {table.getRowModel().rows.map((row) => row.getIsGrouped() ? (
                                <tr key={row.id} className="border-b border-border/50 bg-background-tertiary/30">
                                    <td colSpan={table.getVisibleLeafColumns().length} className="px-3 py-2">
                                        <button type="button" aria-expanded={row.getIsExpanded()} onClick={row.getToggleExpandedHandler()} className="flex flex-wrap items-center gap-3 text-left">
                                            <span aria-hidden="true">{row.getIsExpanded() ? '▾' : '▸'}</span>
                                            <span className="font-medium text-foreground">{String(row.groupingValue)}</span>
                                            <span className="font-mono text-xs text-foreground-muted" style={TNUM}>{row.subRows.length}</span>
                                            {(() => {
                                                const missing = missingForGroup(row.subRows.map((sub) => sub.original));
                                                return missing.length > 0 ? (
                                                    <span className="text-xs text-warning">
                                                        Missing vs {missing[0].priorYear}: {missing.map((entry) => entry.label).join(', ')}
                                                    </span>
                                                ) : null;
                                            })()}
                                        </button>
                                    </td>
                                </tr>
                            ) : (
                                <Fragment key={row.id}>
                                    <tr className="border-b border-border/30 last:border-b-0 hover:bg-surface-hover/50">
                                        {row.getVisibleCells().map((cell) => (
                                            <td key={cell.id} className={`px-3 py-2 align-top text-foreground-secondary ${['issuedOn', 'expiresOn', 'sizeBytes'].includes(cell.column.id) ? 'font-mono' : ''}`} style={['issuedOn', 'expiresOn', 'sizeBytes'].includes(cell.column.id) ? TNUM : undefined}>
                                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                            </td>
                                        ))}
                                    </tr>
                                    {editingId === row.original.id && renderEditor && (
                                        <tr><td colSpan={table.getVisibleLeafColumns().length} className="border-b border-border/30 bg-background-tertiary/30 p-3">{renderEditor(row.original)}</td></tr>
                                    )}
                                </Fragment>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
