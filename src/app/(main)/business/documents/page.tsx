'use client';

import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import type { EntityDocument } from '@/lib/services/entity-documents.service';
import {
    getEditDocumentTypeOptions,
    getEntityDocumentContext,
    getTaxFormLabel,
    TAX_FORM_DEFINITIONS,
    type EntityDocumentProfile,
} from '@/lib/entity-document-context';
import { groupTaxRecordsByYear, findMissingTaxForms } from '@/lib/tax-records';
import { PageHeader } from '@/components/ui/PageHeader';
import { useDocumentPreview } from '@/components/documents/DocumentPreviewModal';
import { useToast } from '@/contexts/ToastContext';
import { Tip } from '@/components/ui/Tooltip';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

interface DocumentsResponse {
    documents: EntityDocument[];
    expiringSoon: EntityDocument[];
    warningDays: number;
}

function formatBytes(bytes: number | null): string {
    if (bytes === null) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ExpiryBadge({ doc }: { doc: EntityDocument }) {
    const days = doc.daysUntilExpiry;
    if (days === null) return null;
    if (days < 0) {
        return (
            <span className="inline-block rounded-full border border-error/30 bg-error/10 px-2 py-0.5 text-[11px] font-medium text-error whitespace-nowrap">
                Expired {doc.expiresOn}
            </span>
        );
    }
    if (days <= 60) {
        return (
            <span className="inline-block rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning whitespace-nowrap">
                Expires in {days}d
            </span>
        );
    }
    return (
        <span className="inline-block rounded-full border border-border bg-background-tertiary px-2 py-0.5 text-[11px] text-foreground-muted whitespace-nowrap">
            Expires {doc.expiresOn}
        </span>
    );
}

interface EditState {
    title: string;
    docType: string;
    expiresOn: string;
    issuedOn: string;
    returnCopyDueOn: string;
    notes: string;
    taxYear: string;
    taxForm: string;
    issuer: string;
}

function editStateFrom(doc: EntityDocument): EditState {
    return {
        title: doc.title,
        docType: doc.docType,
        expiresOn: doc.expiresOn ?? '',
        issuedOn: doc.issuedOn ?? '',
        returnCopyDueOn: doc.returnCopyDueOn ?? '',
        notes: doc.notes ?? '',
        taxYear: doc.taxYear === null ? '' : String(doc.taxYear),
        taxForm: doc.taxForm ?? '',
        issuer: doc.issuer ?? '',
    };
}

function editStateToPayload(edit: EditState) {
    const taxYearParsed = parseInt(edit.taxYear, 10);
    return {
        title: edit.title,
        docType: edit.docType,
        expiresOn: edit.expiresOn || null,
        issuedOn: edit.issuedOn || null,
        returnCopyDueOn: edit.returnCopyDueOn || null,
        notes: edit.notes || null,
        taxYear: edit.docType === 'tax' && Number.isInteger(taxYearParsed) ? taxYearParsed : null,
        taxForm: edit.docType === 'tax' && edit.taxForm ? edit.taxForm : null,
        issuer: edit.docType === 'tax' && edit.issuer.trim() ? edit.issuer.trim() : null,
    };
}

/** One file in the pre-upload staging list. */
interface StagedFile {
    key: string;
    file: File;
    status: 'staged' | 'uploading' | 'done' | 'failed';
    error?: string;
}

interface TaxSuggestions {
    taxForm: string | null;
    taxYear: number | null;
    issuer: string | null;
}

const inputClass =
    'w-full rounded-lg border border-border bg-input-bg px-3 py-2.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-primary/50 focus:outline-none';
const labelClass = 'block text-xs text-foreground-secondary mb-1';

/** Tax subtype fields shown whenever a form's type is 'tax'. */
function TaxFields({
    taxForm,
    taxYear,
    issuer,
    onChange,
}: {
    taxForm: string;
    taxYear: string;
    issuer: string;
    onChange: (patch: { taxForm?: string; taxYear?: string; issuer?: string }) => void;
}) {
    return (
        <>
            <div>
                <label className={labelClass}>Tax form</label>
                <select
                    value={taxForm}
                    onChange={(e) => onChange({ taxForm: e.target.value })}
                    className={inputClass}
                >
                    <option value="">— Select form —</option>
                    {TAX_FORM_DEFINITIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                            {o.label}
                        </option>
                    ))}
                </select>
            </div>
            <div>
                <label className={labelClass}>Tax year</label>
                <input
                    type="number"
                    min={1980}
                    max={2100}
                    value={taxYear}
                    onChange={(e) => onChange({ taxYear: e.target.value })}
                    placeholder="e.g. 2025"
                    className={`${inputClass} font-mono`}
                />
            </div>
            <div>
                <label className={labelClass}>Issuer (institution)</label>
                <input
                    type="text"
                    value={issuer}
                    onChange={(e) => onChange({ issuer: e.target.value })}
                    placeholder="e.g. Fidelity, Acme Corp"
                    className={inputClass}
                />
            </div>
        </>
    );
}

export default function EntityDocumentsPage() {
    const toast = useToast();
    const documentPreview = useDocumentPreview();
    const [data, setData] = useState<DocumentsResponse | null>(null);
    const [entityProfile, setEntityProfile] = useState<EntityDocumentProfile | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Upload panel state — files stage locally and nothing is sent until
    // Upload is pressed; every staged file can be removed first.
    const [staged, setStaged] = useState<StagedFile[]>([]);
    const [uploadTitle, setUploadTitle] = useState('');
    const [uploadType, setUploadType] = useState('other');
    const [uploadExpires, setUploadExpires] = useState('');
    const [uploadIssued, setUploadIssued] = useState('');
    const [uploadReturnCopyDue, setUploadReturnCopyDue] = useState('');
    const [uploadNotes, setUploadNotes] = useState('');
    const [uploadTaxYear, setUploadTaxYear] = useState('');
    const [uploadTaxForm, setUploadTaxForm] = useState('');
    const [uploadIssuer, setUploadIssuer] = useState('');
    const [uploading, setUploading] = useState(false);
    const [dragging, setDragging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Post-upload detailing pass: just-uploaded docs stay editable until
    // dismissed, so a bulk drop can be typed/dated per file afterwards.
    const [detailing, setDetailing] = useState<EntityDocument[]>([]);
    const [detailEdits, setDetailEdits] = useState<Record<number, EditState>>({});
    const [detailSaved, setDetailSaved] = useState<Record<number, boolean>>({});
    const [detailSaving, setDetailSaving] = useState<Record<number, boolean>>({});
    const [suggestions, setSuggestions] = useState<Record<number, TaxSuggestions>>({});
    const pollTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

    // Inline edit state (existing documents)
    const [editingId, setEditingId] = useState<number | null>(null);
    const [edit, setEdit] = useState<EditState | null>(null);
    const [savingEdit, setSavingEdit] = useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/business/documents');
            if (!res.ok) throw new Error(`Request failed (${res.status})`);
            setData(await res.json());
            setError(null);
        } catch {
            setError('Failed to load documents.');
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            await Promise.all([
                load(),
                (async () => {
                    try {
                        const res = await fetch('/api/entity');
                        if (!res.ok) throw new Error(`Request failed (${res.status})`);
                        const profile = (await res.json()) as EntityDocumentProfile;
                        if (!cancelled) setEntityProfile(profile);
                    } catch {
                        // Documents remain usable with deliberately neutral copy.
                        if (!cancelled) setEntityProfile(null);
                    }
                })(),
            ]);
            if (!cancelled) setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [load]);

    useEffect(() => {
        const timers = pollTimers.current;
        return () => {
            for (const timer of timers.values()) clearTimeout(timer);
            timers.clear();
        };
    }, []);

    /**
     * Poll the suggestions endpoint for a tax document until the AI pass
     * finishes (bounded). Suggestions are advisory — Apply fills the form,
     * the user still saves.
     */
    const pollSuggestions = useCallback((documentId: number, attempt = 0) => {
        if (attempt >= 15) return;
        const timer = setTimeout(async () => {
            pollTimers.current.delete(documentId);
            try {
                const res = await fetch(`/api/business/documents/${documentId}/suggestions`);
                if (!res.ok) return;
                const body = await res.json();
                if (body.suggestionKind === 'tax_record' && body.suggestions) {
                    setSuggestions((prev) => ({ ...prev, [documentId]: body.suggestions }));
                    return;
                }
                if (body.extractionStatus === 'pending' || body.extractionStatus === 'processing') {
                    pollSuggestions(documentId, attempt + 1);
                }
            } catch {
                // Suggestion polling is best-effort.
            }
        }, attempt === 0 ? 2500 : 5000);
        pollTimers.current.set(documentId, timer);
    }, []);

    const stageFiles = (files: FileList | File[] | null | undefined) => {
        if (!files || files.length === 0) return;
        const additions: StagedFile[] = [...files].map((file) => ({
            key: `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`,
            file,
            status: 'staged',
        }));
        setStaged((prev) => [...prev, ...additions]);
    };

    const removeStaged = (key: string) => {
        setStaged((prev) => prev.filter((s) => s.key !== key));
    };

    const clearStaged = () => {
        setStaged([]);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setDragging(false);
        stageFiles(e.dataTransfer.files);
    };

    const resetUploadForm = () => {
        clearStaged();
        setUploadTitle('');
        setUploadType('other');
        setUploadExpires('');
        setUploadIssued('');
        setUploadReturnCopyDue('');
        setUploadNotes('');
        setUploadTaxYear('');
        setUploadTaxForm('');
        setUploadIssuer('');
    };

    const handleUpload = async () => {
        const toUpload = staged.filter((s) => s.status === 'staged' || s.status === 'failed');
        if (toUpload.length === 0) {
            toast.error('Choose at least one file first');
            return;
        }
        setUploading(true);
        const singleFile = toUpload.length === 1 && staged.length === 1;
        const created: EntityDocument[] = [];
        let failures = 0;

        for (const item of toUpload) {
            setStaged((prev) =>
                prev.map((s) => (s.key === item.key ? { ...s, status: 'uploading', error: undefined } : s))
            );
            try {
                const formData = new FormData();
                formData.append('file', item.file);
                const title = singleFile && uploadTitle.trim()
                    ? uploadTitle.trim()
                    : item.file.name.replace(/\.[^.]+$/, '');
                formData.append('title', title);
                formData.append('doc_type', uploadType);
                if (uploadExpires) formData.append('expires_on', uploadExpires);
                if (uploadIssued) formData.append('issued_on', uploadIssued);
                if (uploadReturnCopyDue) formData.append('return_copy_due_on', uploadReturnCopyDue);
                if (uploadNotes.trim()) formData.append('notes', uploadNotes.trim());
                if (uploadType === 'tax') {
                    if (uploadTaxYear) formData.append('tax_year', uploadTaxYear);
                    if (uploadTaxForm) formData.append('tax_form', uploadTaxForm);
                    if (uploadIssuer.trim()) formData.append('issuer', uploadIssuer.trim());
                }

                const res = await fetch('/api/business/documents', { method: 'POST', body: formData });
                if (!res.ok) {
                    const json = await res.json().catch(() => null);
                    throw new Error(json?.error ?? 'Upload failed');
                }
                const { document } = (await res.json()) as { document: EntityDocument };
                created.push(document);
                setStaged((prev) =>
                    prev.map((s) => (s.key === item.key ? { ...s, status: 'done' } : s))
                );
            } catch (err) {
                failures += 1;
                setStaged((prev) =>
                    prev.map((s) =>
                        s.key === item.key
                            ? { ...s, status: 'failed', error: err instanceof Error ? err.message : 'Upload failed' }
                            : s
                    )
                );
            }
        }

        setUploading(false);
        if (created.length > 0) {
            toast.success(
                created.length === 1 ? 'Document uploaded' : `${created.length} documents uploaded`
            );
            setDetailing((prev) => [...prev, ...created]);
            setDetailEdits((prev) => ({
                ...prev,
                ...Object.fromEntries(created.map((doc) => [doc.id, editStateFrom(doc)])),
            }));
            for (const doc of created) {
                if (doc.docType === 'tax') pollSuggestions(doc.id);
            }
            await load();
        }
        if (failures > 0) {
            toast.error(`${failures} file${failures === 1 ? '' : 's'} failed to upload`);
        } else if (created.length > 0) {
            resetUploadForm();
        }
    };

    const saveDetail = async (documentId: number) => {
        const detailEdit = detailEdits[documentId];
        if (!detailEdit) return;
        setDetailSaving((prev) => ({ ...prev, [documentId]: true }));
        try {
            const res = await fetch(`/api/business/documents/${documentId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editStateToPayload(detailEdit)),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                throw new Error(json?.error ?? 'Save failed');
            }
            setDetailSaved((prev) => ({ ...prev, [documentId]: true }));
            // A doc switched to 'tax' post-upload: re-run the AI pass so its
            // form/year/issuer suggestions arrive too.
            const wasTax = detailing.find((d) => d.id === documentId)?.docType === 'tax';
            if (detailEdit.docType === 'tax' && !wasTax && !suggestions[documentId]) {
                fetch(`/api/business/documents/${documentId}/suggestions`, { method: 'POST' })
                    .then(() => pollSuggestions(documentId))
                    .catch(() => undefined);
            }
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to save details');
        } finally {
            setDetailSaving((prev) => ({ ...prev, [documentId]: false }));
        }
    };

    const applyTypeToAll = (docType: string) => {
        setDetailEdits((prev) =>
            Object.fromEntries(
                Object.entries(prev).map(([id, state]) => [id, { ...state, docType }])
            )
        );
        setDetailSaved({});
    };

    const applySuggestion = (documentId: number) => {
        const suggestion = suggestions[documentId];
        if (!suggestion) return;
        setDetailEdits((prev) => {
            const current = prev[documentId];
            if (!current) return prev;
            return {
                ...prev,
                [documentId]: {
                    ...current,
                    docType: 'tax',
                    taxForm: suggestion.taxForm ?? current.taxForm,
                    taxYear: suggestion.taxYear !== null ? String(suggestion.taxYear) : current.taxYear,
                    issuer: suggestion.issuer ?? current.issuer,
                },
            };
        });
        setDetailSaved((prev) => ({ ...prev, [documentId]: false }));
    };

    const dismissDetailing = () => {
        setDetailing([]);
        setDetailEdits({});
        setDetailSaved({});
        setDetailSaving({});
        setSuggestions({});
        for (const timer of pollTimers.current.values()) clearTimeout(timer);
        pollTimers.current.clear();
    };

    const startEdit = (doc: EntityDocument) => {
        setEditingId(doc.id);
        setEdit(editStateFrom(doc));
        setConfirmDeleteId(null);
    };

    const handleSaveEdit = async (id: number) => {
        if (!edit) return;
        setSavingEdit(true);
        try {
            const res = await fetch(`/api/business/documents/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editStateToPayload(edit)),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                throw new Error(json?.error ?? 'Save failed');
            }
            toast.success('Document updated');
            setEditingId(null);
            setEdit(null);
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to update document');
        } finally {
            setSavingEdit(false);
        }
    };

    const handleDelete = async (id: number) => {
        try {
            const res = await fetch(`/api/business/documents/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Delete failed');
            toast.success('Document deleted');
            setConfirmDeleteId(null);
            await load();
        } catch {
            toast.error('Failed to delete document');
        }
    };

    const documents = data?.documents ?? [];
    const expiring = data?.expiringSoon ?? [];
    const context = getEntityDocumentContext(entityProfile);
    const contextualTypes = new Set(context.typeOptions.map(({ value }) => value));
    const taxGroups = groupTaxRecordsByYear(documents);
    const missingTaxForms = findMissingTaxForms(documents);
    const documentGroups = [
        ...context.typeOptions
            .filter(({ value }) => value !== 'tax')
            .map(({ value, label }) => ({
                key: value,
                label,
                documents: documents.filter((doc) => doc.docType === value),
            })),
        {
            key: '__legacy__',
            label: 'Other document types',
            documents: documents.filter(
                (doc) => doc.docType !== 'tax' && !contextualTypes.has(doc.docType)
            ),
        },
    ];
    const stagedCount = staged.filter((s) => s.status === 'staged' || s.status === 'failed').length;
    const untypedCount = detailing.filter(
        (doc) => (detailEdits[doc.id]?.docType ?? doc.docType) === 'other'
    ).length;

    const renderDocumentRow = (doc: EntityDocument) => (
        <Fragment key={doc.id}>
            <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/30 px-4 py-2.5 last:border-b-0">
                <div className="min-w-0 flex-1">
                    <span className="text-sm text-foreground">{doc.title}</span>
                    {doc.docType === 'tax' && (doc.taxForm || doc.issuer) && (
                        <span className="ml-2 inline-block rounded-full border border-border bg-background-tertiary px-2 py-0.5 text-[11px] text-foreground-secondary whitespace-nowrap">
                            {[getTaxFormLabel(doc.taxForm), doc.issuer].filter(Boolean).join(' · ')}
                        </span>
                    )}
                    <span className="ml-3 font-mono text-xs text-foreground-muted" style={TNUM}>
                        {doc.fileName ?? '—'} · {formatBytes(doc.sizeBytes)} ·{' '}
                        {doc.uploadedAt.slice(0, 10)}
                    </span>
                    {doc.notes && (
                        <p className="mt-0.5 truncate text-xs text-foreground-muted">
                            {doc.notes}
                        </p>
                    )}
                    {(doc.issuedOn || doc.returnCopyDueOn) && (
                        <p className="mt-0.5 text-xs text-foreground-muted">
                            {doc.issuedOn ? `Issued ${doc.issuedOn}` : ''}
                            {doc.issuedOn && doc.returnCopyDueOn ? ' · ' : ''}
                            {doc.returnCopyDueOn ? `Return copy due ${doc.returnCopyDueOn}` : ''}
                        </p>
                    )}
                </div>
                <ExpiryBadge doc={doc} />
                <div className="flex items-center gap-3 text-sm">
                    <button
                        type="button"
                        onClick={() => documentPreview.open({
                            documentId: doc.id,
                            title: doc.title,
                            fileName: doc.fileName,
                            mimeType: doc.mimeType,
                        })}
                        className="text-primary hover:text-primary-hover transition-colors"
                    >
                        Preview
                    </button>
                    <a
                        href={`/api/business/documents/${doc.id}/download`}
                        className="text-foreground-secondary hover:text-foreground transition-colors"
                    >
                        Download
                    </a>
                    <button
                        type="button"
                        onClick={() => {
                            if (editingId === doc.id) {
                                setEditingId(null);
                                setEdit(null);
                            } else {
                                startEdit(doc);
                            }
                        }}
                        className="text-foreground-secondary hover:text-foreground transition-colors"
                    >
                        Edit
                    </button>
                    {confirmDeleteId === doc.id ? (
                        <span className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => handleDelete(doc.id)}
                                className="font-medium text-error hover:opacity-80 transition-opacity"
                            >
                                Confirm delete
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
                            onClick={() => setConfirmDeleteId(doc.id)}
                            className="text-foreground-muted hover:text-error transition-colors"
                        >
                            Delete
                        </button>
                    )}
                </div>
            </li>
            {editingId === doc.id && edit && (
                <li className="border-b border-border/30 bg-background-tertiary/30 px-4 py-3 last:border-b-0">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        <div>
                            <label className={labelClass}>Title</label>
                            <input
                                type="text"
                                value={edit.title}
                                onChange={(e) => setEdit({ ...edit, title: e.target.value })}
                                className={inputClass}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Type</label>
                            <select
                                value={edit.docType}
                                onChange={(e) => setEdit({ ...edit, docType: e.target.value })}
                                className={inputClass}
                            >
                                {getEditDocumentTypeOptions(context, doc.docType).map((o) => (
                                    <option key={o.value} value={o.value}>
                                        {o.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className={labelClass}>Expires</label>
                            <input
                                type="date"
                                value={edit.expiresOn}
                                onChange={(e) => setEdit({ ...edit, expiresOn: e.target.value })}
                                className={`${inputClass} font-mono`}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Notes</label>
                            <input
                                type="text"
                                value={edit.notes}
                                onChange={(e) => setEdit({ ...edit, notes: e.target.value })}
                                className={inputClass}
                            />
                        </div>
                        {edit.docType === 'tax' && (
                            <TaxFields
                                taxForm={edit.taxForm}
                                taxYear={edit.taxYear}
                                issuer={edit.issuer}
                                onChange={(patch) => setEdit({ ...edit, ...patch })}
                            />
                        )}
                        {(edit.docType === 'farm_certificate_qf' || edit.docType === 'farm_certificate_cf') && (
                            <>
                                <div>
                                    <label className={labelClass}>Issued</label>
                                    <input
                                        type="date"
                                        value={edit.issuedOn}
                                        onChange={(e) => setEdit({ ...edit, issuedOn: e.target.value })}
                                        className={`${inputClass} font-mono`}
                                    />
                                </div>
                                <div>
                                    <label className={labelClass}>Return copy due</label>
                                    <input
                                        type="date"
                                        value={edit.returnCopyDueOn}
                                        onChange={(e) => setEdit({ ...edit, returnCopyDueOn: e.target.value })}
                                        className={`${inputClass} font-mono`}
                                    />
                                </div>
                            </>
                        )}
                    </div>
                    <div className="mt-3 flex items-center gap-3">
                        <button
                            type="button"
                            onClick={() => handleSaveEdit(doc.id)}
                            disabled={savingEdit}
                            className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover transition-colors disabled:opacity-50"
                        >
                            {savingEdit ? 'Saving…' : 'Save'}
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setEditingId(null);
                                setEdit(null);
                            }}
                            className="rounded-lg border border-border px-4 py-1.5 text-sm text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                </li>
            )}
        </Fragment>
    );

    return (
        <div className="space-y-6">
            <PageHeader
                title={context.title}
                subtitle={context.subtitle}
            />

            {loading && (
                <div className="flex items-center justify-center py-12">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading...</span>
                    </div>
                </div>
            )}

            {!loading && error && (
                <div className="border border-error/30 bg-surface/30 rounded-lg p-4">
                    <p className="text-sm text-error">{error}</p>
                </div>
            )}

            {!loading && !error && data && (
                <>
                    {expiring.length > 0 && (
                        <div className="border border-warning/30 bg-warning/5 rounded-lg px-4 py-3 text-sm text-foreground-secondary">
                            <span className="font-medium text-foreground">
                                {expiring.length} document{expiring.length === 1 ? '' : 's'}
                            </span>{' '}
                            expired or expiring within {data.warningDays} days:{' '}
                            {expiring.map((d) => d.title).join(', ')}. Renew and upload the new
                            versions.
                        </div>
                    )}

                    {/* Upload panel */}
                    <div className="bg-background-secondary/30 border border-border rounded-lg p-4 space-y-4">
                        <div
                            onDragOver={(e) => {
                                e.preventDefault();
                                setDragging(true);
                            }}
                            onDragLeave={() => setDragging(false)}
                            onDrop={handleDrop}
                            onClick={() => fileInputRef.current?.click()}
                            className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors ${
                                dragging
                                    ? 'border-primary bg-primary-light'
                                    : 'border-border hover:border-border-hover'
                            }`}
                        >
                            <input
                                ref={fileInputRef}
                                type="file"
                                multiple
                                accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                                className="hidden"
                                onChange={(e) => {
                                    stageFiles(e.target.files);
                                    e.target.value = '';
                                }}
                            />
                            <p className="text-sm text-foreground-secondary">
                                Drag files here, or click to browse
                            </p>
                            <p className="mt-1 text-xs text-foreground-muted">
                                PDF, PNG, or JPEG — up to 10MB each. Multiple files upload as a batch.
                            </p>
                        </div>

                        {/* Staged files: reviewable and removable before anything is sent */}
                        {staged.length > 0 && (
                            <ul className="divide-y divide-border/30 rounded-lg border border-border">
                                {staged.map((item) => (
                                    <li
                                        key={item.key}
                                        className="flex items-center gap-3 px-3 py-2 text-sm"
                                    >
                                        <span className="min-w-0 flex-1 truncate text-foreground">
                                            {item.file.name}
                                            <span className="ml-2 font-mono text-xs text-foreground-muted" style={TNUM}>
                                                ({formatBytes(item.file.size)})
                                            </span>
                                        </span>
                                        {item.status === 'uploading' && (
                                            <span className="text-xs text-foreground-muted">Uploading…</span>
                                        )}
                                        {item.status === 'done' && (
                                            <span className="text-xs text-success">Uploaded</span>
                                        )}
                                        {item.status === 'failed' && (
                                            <Tip content={item.error}>
                                            <span className="text-xs text-error">
                                                {item.error ?? 'Failed'}
                                            </span>
                                            </Tip>
                                        )}
                                        {(item.status === 'staged' || item.status === 'failed') && !uploading && (
                                            <button
                                                type="button"
                                                onClick={() => removeStaged(item.key)}
                                                aria-label={`Remove ${item.file.name}`}
                                                className="text-foreground-muted hover:text-error transition-colors"
                                            >
                                                Remove
                                            </button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}

                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            <div>
                                <label className={labelClass}>
                                    Title{staged.length > 1 ? ' (single file only — batches use filenames)' : ''}
                                </label>
                                <input
                                    type="text"
                                    value={uploadTitle}
                                    onChange={(e) => setUploadTitle(e.target.value)}
                                    placeholder={context.uploadTitlePlaceholder}
                                    disabled={staged.length > 1}
                                    className={`${inputClass} disabled:opacity-50`}
                                />
                            </div>
                            <div>
                                <label className={labelClass}>
                                    Type{staged.length > 1 ? ' (applies to all staged files)' : ''}
                                </label>
                                <select
                                    value={uploadType}
                                    onChange={(e) => setUploadType(e.target.value)}
                                    className={inputClass}
                                >
                                    {context.typeOptions.map((o) => (
                                        <option key={o.value} value={o.value}>
                                            {o.label}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className={labelClass}>Expires (optional)</label>
                                <input
                                    type="date"
                                    value={uploadExpires}
                                    onChange={(e) => setUploadExpires(e.target.value)}
                                    className={`${inputClass} font-mono`}
                                />
                            </div>
                            {uploadType === 'tax' && (
                                <TaxFields
                                    taxForm={uploadTaxForm}
                                    taxYear={uploadTaxYear}
                                    issuer={uploadIssuer}
                                    onChange={(patch) => {
                                        if (patch.taxForm !== undefined) setUploadTaxForm(patch.taxForm);
                                        if (patch.taxYear !== undefined) setUploadTaxYear(patch.taxYear);
                                        if (patch.issuer !== undefined) setUploadIssuer(patch.issuer);
                                    }}
                                />
                            )}
                            {(uploadType === 'farm_certificate_qf' || uploadType === 'farm_certificate_cf') && (
                                <>
                                    <div>
                                        <label className={labelClass}>Issued (optional)</label>
                                        <input
                                            type="date"
                                            value={uploadIssued}
                                            onChange={(e) => setUploadIssued(e.target.value)}
                                            className={`${inputClass} font-mono`}
                                        />
                                    </div>
                                    <div>
                                        <label className={labelClass}>Return copy due (optional)</label>
                                        <input
                                            type="date"
                                            value={uploadReturnCopyDue}
                                            onChange={(e) => setUploadReturnCopyDue(e.target.value)}
                                            className={`${inputClass} font-mono`}
                                        />
                                    </div>
                                </>
                            )}
                            <div className="flex items-end gap-2">
                                <button
                                    type="button"
                                    onClick={handleUpload}
                                    disabled={uploading || stagedCount === 0}
                                    className="flex-1 rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover transition-colors disabled:opacity-50"
                                >
                                    {uploading
                                        ? 'Uploading…'
                                        : stagedCount > 1
                                          ? `Upload ${stagedCount} files`
                                          : 'Upload'}
                                </button>
                                {staged.length > 0 && !uploading && (
                                    <button
                                        type="button"
                                        onClick={clearStaged}
                                        className="rounded-lg border border-border px-4 py-1.5 text-sm text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors"
                                    >
                                        Cancel
                                    </button>
                                )}
                            </div>
                        </div>
                        <div>
                            <label className={labelClass}>Notes (optional)</label>
                            <input
                                type="text"
                                value={uploadNotes}
                                onChange={(e) => setUploadNotes(e.target.value)}
                                placeholder={context.notesPlaceholder}
                                className={inputClass}
                            />
                        </div>
                    </div>

                    {/* Post-upload detailing pass */}
                    {detailing.length > 0 && (
                        <div className="bg-background-secondary/30 border border-primary/30 rounded-lg p-4 space-y-3">
                            <div className="flex flex-wrap items-center gap-3">
                                <h3 className="text-sm font-medium text-foreground">
                                    Set details for the uploaded files
                                </h3>
                                <span className="font-mono text-xs text-foreground-muted" style={TNUM}>
                                    {untypedCount > 0
                                        ? `${untypedCount} of ${detailing.length} still untyped`
                                        : `${detailing.length} file${detailing.length === 1 ? '' : 's'}`}
                                </span>
                                {detailing.length > 1 && (
                                    <label className="ml-auto flex items-center gap-2 text-xs text-foreground-secondary">
                                        Apply type to all
                                        <select
                                            defaultValue=""
                                            onChange={(e) => {
                                                if (e.target.value) applyTypeToAll(e.target.value);
                                                e.target.value = '';
                                            }}
                                            className="rounded-lg border border-border bg-input-bg px-2 py-1 text-xs text-foreground"
                                        >
                                            <option value="">— choose —</option>
                                            {context.typeOptions.map((o) => (
                                                <option key={o.value} value={o.value}>
                                                    {o.label}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                )}
                                <button
                                    type="button"
                                    onClick={dismissDetailing}
                                    className="rounded-lg border border-border px-3 py-1 text-xs text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors"
                                >
                                    Done
                                </button>
                            </div>
                            <ul className="divide-y divide-border/30">
                                {detailing.map((doc) => {
                                    const detailEdit = detailEdits[doc.id];
                                    if (!detailEdit) return null;
                                    const suggestion = suggestions[doc.id];
                                    return (
                                        <li key={doc.id} className="py-3 space-y-2">
                                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                                <span className="font-mono text-xs text-foreground-muted" style={TNUM}>
                                                    {doc.fileName}
                                                </span>
                                                {detailSaved[doc.id] && (
                                                    <span className="text-xs text-success">Saved</span>
                                                )}
                                                {suggestion && (
                                                    <span className="flex items-center gap-2 text-xs text-foreground-secondary">
                                                        <span className="inline-block rounded-full border border-primary/30 bg-primary-light px-2 py-0.5 text-[11px]">
                                                            AI: {[
                                                                getTaxFormLabel(suggestion.taxForm),
                                                                suggestion.taxYear,
                                                                suggestion.issuer,
                                                            ].filter(Boolean).join(' · ') || 'no suggestion'}
                                                        </span>
                                                        <button
                                                            type="button"
                                                            onClick={() => applySuggestion(doc.id)}
                                                            className="text-primary hover:text-primary-hover transition-colors"
                                                        >
                                                            Apply
                                                        </button>
                                                    </span>
                                                )}
                                            </div>
                                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                                <div>
                                                    <label className={labelClass}>Title</label>
                                                    <input
                                                        type="text"
                                                        value={detailEdit.title}
                                                        onChange={(e) => {
                                                            setDetailEdits((prev) => ({
                                                                ...prev,
                                                                [doc.id]: { ...detailEdit, title: e.target.value },
                                                            }));
                                                            setDetailSaved((prev) => ({ ...prev, [doc.id]: false }));
                                                        }}
                                                        className={inputClass}
                                                    />
                                                </div>
                                                <div>
                                                    <label className={labelClass}>Type</label>
                                                    <select
                                                        value={detailEdit.docType}
                                                        onChange={(e) => {
                                                            setDetailEdits((prev) => ({
                                                                ...prev,
                                                                [doc.id]: { ...detailEdit, docType: e.target.value },
                                                            }));
                                                            setDetailSaved((prev) => ({ ...prev, [doc.id]: false }));
                                                        }}
                                                        className={inputClass}
                                                    >
                                                        {getEditDocumentTypeOptions(context, doc.docType).map((o) => (
                                                            <option key={o.value} value={o.value}>
                                                                {o.label}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </div>
                                                <div>
                                                    <label className={labelClass}>Expires</label>
                                                    <input
                                                        type="date"
                                                        value={detailEdit.expiresOn}
                                                        onChange={(e) => {
                                                            setDetailEdits((prev) => ({
                                                                ...prev,
                                                                [doc.id]: { ...detailEdit, expiresOn: e.target.value },
                                                            }));
                                                            setDetailSaved((prev) => ({ ...prev, [doc.id]: false }));
                                                        }}
                                                        className={`${inputClass} font-mono`}
                                                    />
                                                </div>
                                                {detailEdit.docType === 'tax' && (
                                                    <TaxFields
                                                        taxForm={detailEdit.taxForm}
                                                        taxYear={detailEdit.taxYear}
                                                        issuer={detailEdit.issuer}
                                                        onChange={(patch) => {
                                                            setDetailEdits((prev) => ({
                                                                ...prev,
                                                                [doc.id]: { ...detailEdit, ...patch },
                                                            }));
                                                            setDetailSaved((prev) => ({ ...prev, [doc.id]: false }));
                                                        }}
                                                    />
                                                )}
                                                <div className="flex items-end">
                                                    <button
                                                        type="button"
                                                        onClick={() => saveDetail(doc.id)}
                                                        disabled={detailSaving[doc.id] || detailSaved[doc.id]}
                                                        className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover transition-colors disabled:opacity-50"
                                                    >
                                                        {detailSaving[doc.id]
                                                            ? 'Saving…'
                                                            : detailSaved[doc.id]
                                                              ? 'Saved'
                                                              : 'Save'}
                                                    </button>
                                                </div>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    )}

                    {documents.length === 0 ? (
                        <div className="bg-background-secondary/30 border border-border rounded-lg p-8 text-center space-y-2">
                            <p className="text-sm text-foreground-secondary">
                                {context.starterIntro}
                            </p>
                            <p className="text-sm text-foreground-secondary">
                                {context.starterExamples.map((example, index) => (
                                    <Fragment key={example}>
                                        {index > 0 && (index === context.starterExamples.length - 1 ? ', and ' : ', ')}
                                        <span className="text-foreground font-medium">{example}</span>
                                    </Fragment>
                                ))}
                                .
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {/* Tax records grouped by year */}
                            {taxGroups.length > 0 && (
                                <div className="bg-background-secondary/30 border border-border rounded-lg overflow-hidden">
                                    <div className="border-b border-border px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-foreground-muted">
                                        Tax records
                                        <span className="ml-2 font-mono" style={TNUM}>
                                            {taxGroups.reduce((sum, g) => sum + g.documents.length, 0)}
                                        </span>
                                    </div>
                                    {taxGroups.map((group) => {
                                        const missing = group.year === null
                                            ? []
                                            : missingTaxForms.filter((m) => m.year === group.year);
                                        return (
                                            <div key={group.year ?? 'none'}>
                                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/50 bg-background-tertiary/30 px-4 py-2">
                                                    <span className="font-mono text-sm font-medium text-foreground" style={TNUM}>
                                                        {group.year ?? 'No tax year set'}
                                                    </span>
                                                    <span className="font-mono text-xs text-foreground-muted" style={TNUM}>
                                                        {group.documents.length}
                                                    </span>
                                                    {missing.length > 0 && (
                                                        <span className="text-xs text-warning">
                                                            Missing vs {group.year! - 1}:{' '}
                                                            {missing.map((m) => m.label).join(', ')}
                                                        </span>
                                                    )}
                                                </div>
                                                <ul>{group.documents.map(renderDocumentRow)}</ul>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {documentGroups.map((group) => {
                                const docs = group.documents;
                                if (docs.length === 0) return null;
                                return (
                                    <div
                                        key={group.key}
                                        className="bg-background-secondary/30 border border-border rounded-lg overflow-hidden"
                                    >
                                        <div className="border-b border-border px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-foreground-muted">
                                            {group.label}
                                            <span className="ml-2 font-mono" style={TNUM}>
                                                {docs.length}
                                            </span>
                                        </div>
                                        <ul>{docs.map(renderDocumentRow)}</ul>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    <p className="text-xs text-foreground-muted">
                        Files are stored with the same backend as receipts (10MB max; PDF, PNG, JPEG).
                        Expiry reminders surface here when a document is expired or within{' '}
                        {data.warningDays} days of expiry. Tax records with a year and form type are
                        grouped by tax year and checked against the prior year&apos;s forms.
                    </p>
                </>
            )}

            {documentPreview.preview}
        </div>
    );
}
