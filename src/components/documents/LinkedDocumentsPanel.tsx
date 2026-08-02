'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { INPUT, LABEL } from '@/components/ui/form';
import { useCurrentUser } from '@/hooks/useCurrentUser';

export interface LinkedDocumentRole {
    value: string;
    label: string;
}

export interface LinkedDocumentsPanelProps {
    targetType: string;
    targetId: string;
    roles: readonly LinkedDocumentRole[];
    title?: string;
    readonly?: boolean;
    className?: string;
}

interface CanonicalDocument {
    id: number;
    title: string | null;
    filename: string;
    mimeType: string | null;
    sourceKind: string;
    sourceId: string | null;
    extractionStatus: string;
}

interface DocumentLink {
    id: number;
    documentId: number;
    targetType: string;
    targetId: string;
    role: string;
}

interface LinkedDocumentResponse {
    link: DocumentLink;
    document: CanonicalDocument;
}

let documentListCache: CanonicalDocument[] | null = null;
let documentListRequest: Promise<CanonicalDocument[]> | null = null;
let documentListCachedAt = 0;
const DOCUMENT_LIST_CACHE_MS = 30_000;

async function fetchDocumentList(force = false): Promise<CanonicalDocument[]> {
    if (force) {
        documentListCache = null;
        documentListRequest = null;
    }
    if (documentListCache && Date.now() - documentListCachedAt < DOCUMENT_LIST_CACHE_MS) return documentListCache;
    if (!documentListRequest) {
        documentListRequest = fetch('/api/documents?limit=100', { cache: 'no-store' })
            .then(async response => {
                const body = await response.json().catch(() => null) as { documents?: CanonicalDocument[]; error?: string } | null;
                if (!response.ok) throw new Error(responseError(body, 'Failed to load the document vault'));
                documentListCache = body?.documents ?? [];
                documentListCachedAt = Date.now();
                return documentListCache;
            })
            .finally(() => {
                documentListRequest = null;
            });
    }
    return documentListRequest;
}

function invalidateDocumentList() {
    documentListCache = null;
    documentListRequest = null;
    documentListCachedAt = 0;
}

const SOURCE_LABELS: Record<string, string> = {
    entity_document: 'Document vault',
    receipt: 'Receipt',
    statement_batch: 'Statement',
    payslip: 'Payslip',
    home_item_photo: 'Home photo',
    import: 'Imported file',
};

const STATUS_LABELS: Record<string, string> = {
    pending: 'Awaiting text extraction',
    processing: 'Extracting text',
    completed: 'Text ready',
    failed: 'Extraction failed',
    skipped: 'Extraction skipped',
    not_applicable: 'No extraction needed',
};

function documentUrl(document: CanonicalDocument): string | null {
    if (!document.sourceId) return null;
    const sourceId = encodeURIComponent(document.sourceId);
    switch (document.sourceKind) {
        case 'entity_document':
            return `/api/business/documents/${sourceId}/download?disposition=inline`;
        case 'receipt':
            return `/api/receipts/${sourceId}`;
        case 'statement_batch':
            return `/api/statements/${sourceId}?view=file`;
        case 'payslip':
            return `/api/payslips/${sourceId}?view=pdf`;
        default:
            return null;
    }
}

function responseError(body: unknown, fallback: string): string {
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
        return body.error;
    }
    return fallback;
}

/**
 * Book-scoped canonical document links for a single feature record.
 *
 * Feature forms only supply a typed target and its allowed roles. The panel
 * stores canonical document IDs in the link table; it never writes IDs into
 * the feature's own JSON or metadata fields.
 */
export function LinkedDocumentsPanel({
    targetType,
    targetId,
    roles,
    title = 'Supporting documents',
    readonly = false,
    className,
}: LinkedDocumentsPanelProps) {
    const { isReadonly } = useCurrentUser();
    const mutationsHidden = readonly || isReadonly;
    const [documents, setDocuments] = useState<CanonicalDocument[]>([]);
    const [links, setLinks] = useState<DocumentLink[]>([]);
    const [selectedDocumentId, setSelectedDocumentId] = useState('');
    const [selectedRole, setSelectedRole] = useState(roles[0]?.value ?? '');
    const [uploadFile, setUploadFile] = useState<File | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setSelectedRole(current => roles.some(role => role.value === current) ? current : (roles[0]?.value ?? ''));
    }, [roles]);

    const load = useCallback(async () => {
        if (!targetId) return;
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams({ targetType, targetId });
            const [vaultDocuments, linksResponse] = await Promise.all([
                fetchDocumentList(),
                fetch(`/api/documents/links?${params.toString()}`, { cache: 'no-store' }),
            ]);
            const linksBody = await linksResponse.json().catch(() => null) as { links?: LinkedDocumentResponse[] } | null;
            if (!linksResponse.ok) throw new Error(responseError(linksBody, 'Failed to load linked documents'));
            const linked = linksBody?.links ?? [];
            const mergedDocuments = new Map(vaultDocuments.map(document => [document.id, document]));
            for (const item of linked) mergedDocuments.set(item.document.id, item.document);
            setDocuments([...mergedDocuments.values()]);
            setLinks(linked.map(item => item.link));
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : 'Failed to load supporting documents');
        } finally {
            setLoading(false);
        }
    }, [targetId, targetType]);

    useEffect(() => {
        void load();
    }, [load]);

    const documentsById = useMemo(
        () => new Map(documents.map(document => [document.id, document])),
        [documents],
    );
    const roleLabels = useMemo(
        () => new Map(roles.map(role => [role.value, role.label])),
        [roles],
    );

    const attach = async (documentId: number, role: string) => {
        const response = await fetch('/api/documents/links', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ documentId, targetType, targetId, role }),
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(responseError(body, 'Failed to attach document'));
    };

    const handleAttach = async () => {
        const documentId = Number(selectedDocumentId);
        if (!Number.isInteger(documentId) || documentId <= 0 || !selectedRole) return;
        setBusy(true);
        setError(null);
        try {
            await attach(documentId, selectedRole);
            setSelectedDocumentId('');
            await load();
        } catch (attachError) {
            setError(attachError instanceof Error ? attachError.message : 'Failed to attach document');
        } finally {
            setBusy(false);
        }
    };

    const handleUpload = async () => {
        if (!uploadFile || !selectedRole) return;
        setBusy(true);
        setError(null);
        try {
            const formData = new FormData();
            formData.set('file', uploadFile);
            formData.set('title', uploadFile.name);
            formData.set('doc_type', 'other');
            const response = await fetch('/api/business/documents', { method: 'POST', body: formData });
            const body = await response.json().catch(() => null) as {
                document?: { id?: number; canonicalDocumentId?: number };
                error?: string;
            } | null;
            if (!response.ok) throw new Error(responseError(body, 'Upload failed'));

            invalidateDocumentList();
            let documentId = body?.document?.canonicalDocumentId ?? null;
            if (!documentId) {
                const refreshedDocuments = await fetchDocumentList(true);
                const sourceId = body?.document?.id == null ? null : String(body.document.id);
                documentId = refreshedDocuments.find(
                    document => document.sourceKind === 'entity_document' && document.sourceId === sourceId,
                )?.id ?? null;
            }
            if (!documentId) throw new Error('Uploaded, but the new document could not be resolved');
            await attach(documentId, selectedRole);
            setUploadFile(null);
            await load();
        } catch (uploadError) {
            setError(uploadError instanceof Error ? uploadError.message : 'Failed to upload document');
        } finally {
            setBusy(false);
        }
    };

    const handleUnlink = async (link: DocumentLink) => {
        setBusy(true);
        setError(null);
        try {
            const response = await fetch(`/api/documents/links/${link.documentId}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetType, targetId, role: link.role }),
            });
            const body = await response.json().catch(() => null);
            if (!response.ok) throw new Error(responseError(body, 'Failed to unlink document'));
            await load();
        } catch (unlinkError) {
            setError(unlinkError instanceof Error ? unlinkError.message : 'Failed to unlink document');
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className={`rounded-md border border-border bg-background-secondary/30 p-4${className ? ` ${className}` : ''}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h4 className="text-sm font-semibold text-foreground">{title}</h4>
                <span className="font-mono text-xs text-foreground-muted">{links.length} linked</span>
            </div>

            {loading ? (
                <p className="mt-3 text-xs text-foreground-muted">Loading documents…</p>
            ) : (
                <>
                    {links.length === 0 ? (
                        <p className="mt-3 text-xs text-foreground-muted">No supporting documents linked.</p>
                    ) : (
                        <ul className="mt-3 divide-y divide-border/60 border-y border-border/60">
                            {links.map(link => {
                                const document = documentsById.get(link.documentId);
                                const href = document ? documentUrl(document) : null;
                                return (
                                    <li key={link.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs">
                                        <div className="min-w-[180px] flex-1">
                                            <p className="truncate font-medium text-foreground">
                                                {document?.title || document?.filename || `Document #${link.documentId}`}
                                            </p>
                                            <p className="text-foreground-muted">
                                                {roleLabels.get(link.role) ?? link.role.replaceAll('_', ' ')} ·{' '}
                                                {SOURCE_LABELS[document?.sourceKind ?? ''] ?? document?.sourceKind ?? 'Document'} ·{' '}
                                                {STATUS_LABELS[document?.extractionStatus ?? ''] ?? document?.extractionStatus ?? 'Metadata only'}
                                            </p>
                                        </div>
                                        {href && (
                                            <a
                                                href={href}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="text-primary transition-colors hover:text-primary-hover"
                                            >
                                                Open
                                            </a>
                                        )}
                                        {!mutationsHidden && (
                                            <button
                                                type="button"
                                                onClick={() => void handleUnlink(link)}
                                                disabled={busy}
                                                className="text-foreground-muted transition-colors hover:text-negative disabled:opacity-50"
                                            >
                                                Unlink
                                            </button>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}

                    {!mutationsHidden && (
                        <div className="mt-4 space-y-3 border-t border-border pt-3">
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(160px,0.55fr)_auto] sm:items-end">
                                <label>
                                    <span className={LABEL}>Document in vault</span>
                                    <select
                                        className={INPUT}
                                        value={selectedDocumentId}
                                        onChange={event => setSelectedDocumentId(event.target.value)}
                                    >
                                        <option value="">Select a document</option>
                                        {documents.map(document => (
                                            <option key={document.id} value={document.id}>
                                                {document.title || document.filename} ({SOURCE_LABELS[document.sourceKind] ?? document.sourceKind})
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label>
                                    <span className={LABEL}>Document role</span>
                                    <select
                                        className={INPUT}
                                        value={selectedRole}
                                        onChange={event => setSelectedRole(event.target.value)}
                                    >
                                        {roles.map(role => <option key={role.value} value={role.value}>{role.label}</option>)}
                                    </select>
                                </label>
                                <button
                                    type="button"
                                    onClick={() => void handleAttach()}
                                    disabled={busy || !selectedDocumentId || !selectedRole}
                                    className="rounded-md border border-primary px-3 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary-light disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    Attach
                                </button>
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                                <input
                                    type="file"
                                    aria-label="Upload a supporting document"
                                    accept="application/pdf,image/jpeg,image/png"
                                    onChange={event => setUploadFile(event.target.files?.[0] ?? null)}
                                    className="min-w-0 flex-1 text-xs text-foreground-secondary file:mr-3 file:rounded-md file:border file:border-border file:bg-background-tertiary file:px-3 file:py-2 file:text-xs file:text-foreground-secondary"
                                />
                                <button
                                    type="button"
                                    onClick={() => void handleUpload()}
                                    disabled={busy || !uploadFile || !selectedRole}
                                    className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {busy ? 'Working…' : 'Upload and attach'}
                                </button>
                            </div>
                        </div>
                    )}
                </>
            )}

            {error && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-negative/30 bg-negative/10 px-3 py-2 text-xs text-negative">
                    <span>{error}</span>
                    <button type="button" onClick={() => void load()} className="font-medium underline underline-offset-2">
                        Retry
                    </button>
                </div>
            )}
        </section>
    );
}
