'use client';

import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import type { EntityDocument } from '@/lib/services/entity-documents.service';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/contexts/ToastContext';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

const TYPE_GROUPS: Array<{ type: string; label: string }> = [
    { type: 'formation', label: 'Formation' },
    { type: 'ein', label: 'EIN' },
    { type: 'election', label: 'Elections' },
    { type: 'insurance', label: 'Insurance' },
    { type: 'license', label: 'Licenses' },
    { type: 'agreement', label: 'Agreements' },
    { type: 'other', label: 'Other' },
];

const TYPE_OPTIONS = TYPE_GROUPS.map((g) => ({ value: g.type, label: g.label }));

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
    notes: string;
}

const inputClass =
    'w-full rounded-lg border border-border bg-input-bg px-2.5 py-1.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-primary/50 focus:outline-none';
const labelClass = 'block text-xs text-foreground-secondary mb-1';

export default function EntityDocumentsPage() {
    const toast = useToast();
    const [data, setData] = useState<DocumentsResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Upload panel state
    const [file, setFile] = useState<File | null>(null);
    const [uploadTitle, setUploadTitle] = useState('');
    const [uploadType, setUploadType] = useState('other');
    const [uploadExpires, setUploadExpires] = useState('');
    const [uploadNotes, setUploadNotes] = useState('');
    const [uploading, setUploading] = useState(false);
    const [dragging, setDragging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Inline edit state
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
            await load();
            if (!cancelled) setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [load]);

    const chooseFile = (f: File | null) => {
        setFile(f);
        if (f && !uploadTitle.trim()) {
            setUploadTitle(f.name.replace(/\.[^.]+$/, ''));
        }
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setDragging(false);
        const dropped = e.dataTransfer.files?.[0];
        if (dropped) chooseFile(dropped);
    };

    const handleUpload = async () => {
        if (!file) {
            toast.error('Choose a file first');
            return;
        }
        setUploading(true);
        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('title', uploadTitle.trim() || file.name);
            formData.append('doc_type', uploadType);
            if (uploadExpires) formData.append('expires_on', uploadExpires);
            if (uploadNotes.trim()) formData.append('notes', uploadNotes.trim());

            const res = await fetch('/api/business/documents', { method: 'POST', body: formData });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                throw new Error(json?.error ?? 'Upload failed');
            }
            toast.success('Document uploaded');
            setFile(null);
            setUploadTitle('');
            setUploadType('other');
            setUploadExpires('');
            setUploadNotes('');
            if (fileInputRef.current) fileInputRef.current.value = '';
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Upload failed');
        } finally {
            setUploading(false);
        }
    };

    const startEdit = (doc: EntityDocument) => {
        setEditingId(doc.id);
        setEdit({
            title: doc.title,
            docType: doc.docType,
            expiresOn: doc.expiresOn ?? '',
            notes: doc.notes ?? '',
        });
        setConfirmDeleteId(null);
    };

    const handleSaveEdit = async (id: number) => {
        if (!edit) return;
        setSavingEdit(true);
        try {
            const res = await fetch(`/api/business/documents/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: edit.title,
                    docType: edit.docType,
                    expiresOn: edit.expiresOn || null,
                    notes: edit.notes || null,
                }),
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

    return (
        <div className="space-y-6">
            <PageHeader
                title="Entity Documents"
                subtitle="The document vault for this entity: formation papers, EIN letter, elections, insurance certificates, licenses, and agreements — with expiry tracking."
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
                <div className="border border-error/30 bg-surface/30 rounded-xl p-4">
                    <p className="text-sm text-error">{error}</p>
                </div>
            )}

            {!loading && !error && data && (
                <>
                    {expiring.length > 0 && (
                        <div className="border border-warning/30 bg-warning/5 rounded-xl px-4 py-3 text-sm text-foreground-secondary">
                            <span className="font-medium text-foreground">
                                {expiring.length} document{expiring.length === 1 ? '' : 's'}
                            </span>{' '}
                            expired or expiring within {data.warningDays} days:{' '}
                            {expiring.map((d) => d.title).join(', ')}. Renew and upload the new
                            versions.
                        </div>
                    )}

                    {/* Upload panel */}
                    <div className="bg-background-secondary/30 border border-border rounded-xl p-4 space-y-4">
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
                                accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                                className="hidden"
                                onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
                            />
                            {file ? (
                                <p className="text-sm text-foreground">
                                    <span className="font-medium">{file.name}</span>{' '}
                                    <span className="font-mono text-xs text-foreground-muted" style={TNUM}>
                                        ({formatBytes(file.size)})
                                    </span>
                                </p>
                            ) : (
                                <>
                                    <p className="text-sm text-foreground-secondary">
                                        Drag a file here, or click to browse
                                    </p>
                                    <p className="mt-1 text-xs text-foreground-muted">
                                        PDF, PNG, or JPEG — up to 10MB
                                    </p>
                                </>
                            )}
                        </div>

                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            <div>
                                <label className={labelClass}>Title</label>
                                <input
                                    type="text"
                                    value={uploadTitle}
                                    onChange={(e) => setUploadTitle(e.target.value)}
                                    placeholder="e.g. EIN assignment letter"
                                    className={inputClass}
                                />
                            </div>
                            <div>
                                <label className={labelClass}>Type</label>
                                <select
                                    value={uploadType}
                                    onChange={(e) => setUploadType(e.target.value)}
                                    className={inputClass}
                                >
                                    {TYPE_OPTIONS.map((o) => (
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
                            <div className="flex items-end">
                                <button
                                    type="button"
                                    onClick={handleUpload}
                                    disabled={uploading || !file}
                                    className="w-full rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover transition-colors disabled:opacity-50"
                                >
                                    {uploading ? 'Uploading…' : 'Upload'}
                                </button>
                            </div>
                        </div>
                        <div>
                            <label className={labelClass}>Notes (optional)</label>
                            <input
                                type="text"
                                value={uploadNotes}
                                onChange={(e) => setUploadNotes(e.target.value)}
                                placeholder="Policy number, filing date, renewal contact…"
                                className={inputClass}
                            />
                        </div>
                    </div>

                    {documents.length === 0 ? (
                        <div className="bg-background-secondary/30 border border-border rounded-xl p-8 text-center space-y-2">
                            <p className="text-sm text-foreground-secondary">
                                No documents yet. A good starter set for the vault:
                            </p>
                            <p className="text-sm text-foreground-secondary">
                                the <span className="text-foreground font-medium">EIN assignment letter</span>,
                                the <span className="text-foreground font-medium">operating agreement</span>,
                                your <span className="text-foreground font-medium">insurance certificate</span>
                                {' '}— and once elected, <span className="text-foreground font-medium">Form 2553</span> (S-corp election).
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {TYPE_GROUPS.map((group) => {
                                const docs = documents.filter((d) => d.docType === group.type);
                                if (docs.length === 0) return null;
                                return (
                                    <div
                                        key={group.type}
                                        className="bg-background-secondary/30 border border-border rounded-xl overflow-hidden"
                                    >
                                        <div className="border-b border-border px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-foreground-muted">
                                            {group.label}
                                            <span className="ml-2 font-mono" style={TNUM}>
                                                {docs.length}
                                            </span>
                                        </div>
                                        <ul>
                                            {docs.map((doc) => (
                                                <Fragment key={doc.id}>
                                                    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/30 px-4 py-2.5 last:border-b-0">
                                                        <div className="min-w-0 flex-1">
                                                            <span className="text-sm text-foreground">{doc.title}</span>
                                                            <span className="ml-3 font-mono text-xs text-foreground-muted" style={TNUM}>
                                                                {doc.fileName ?? '—'} · {formatBytes(doc.sizeBytes)} ·{' '}
                                                                {doc.uploadedAt.slice(0, 10)}
                                                            </span>
                                                            {doc.notes && (
                                                                <p className="mt-0.5 truncate text-xs text-foreground-muted">
                                                                    {doc.notes}
                                                                </p>
                                                            )}
                                                        </div>
                                                        <ExpiryBadge doc={doc} />
                                                        <div className="flex items-center gap-3 text-sm">
                                                            <a
                                                                href={`/api/business/documents/${doc.id}/download`}
                                                                className="text-primary hover:text-primary-hover transition-colors"
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
                                                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
                                                                        {TYPE_OPTIONS.map((o) => (
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
                                            ))}
                                        </ul>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    <p className="text-xs text-foreground-muted">
                        Files are stored with the same backend as receipts (10MB max; PDF, PNG, JPEG).
                        Expiry reminders surface here when a document is expired or within{' '}
                        {data.warningDays} days of expiry.
                    </p>
                </>
            )}
        </div>
    );
}
