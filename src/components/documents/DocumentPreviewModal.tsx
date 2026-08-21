'use client';

import { useCallback, useEffect, useState } from 'react';
import { PdfCanvasPreview } from '@/components/documents/PdfCanvasPreview';
import { Modal } from '@/components/ui/Modal';
import {
    documentDownloadUrl,
    documentInlineUrl,
    resolvePreviewKind,
    type DocumentPreviewKind,
} from '@/lib/document-preview';

export interface DocumentPreviewTarget {
    documentId: number;
    title?: string | null;
    fileName?: string | null;
    mimeType?: string | null;
}

interface DocumentPreviewModalProps extends Omit<Partial<DocumentPreviewTarget>, 'documentId'> {
    /** null while nothing is selected; the modal renders nothing in that case. */
    documentId: number | null;
    isOpen: boolean;
    onClose: () => void;
}

type ProbeState =
    | { status: 'probing' }
    | { status: 'ready'; mimeType: string | null }
    | { status: 'error'; message: string };

/** Probe result tagged with the document it belongs to, so a new target reads as loading. */
type KeyedProbe = ProbeState & { key: number | null };

/**
 * In-browser preview for a vault document.
 *
 * PDFs render via pdf.js onto canvases (PdfCanvasPreview) — never the
 * browser's built-in viewer, whose plugin refuses to run under the response's
 * CSP `sandbox` and makes Chrome download the file instead (a native save
 * dialog popping over the app). Images render as an `<img>`. Anything else
 * (or a document whose type we cannot determine) shows a download prompt
 * rather than an empty frame, so every caller degrades cleanly.
 */
export function DocumentPreviewModal({
    documentId,
    title,
    fileName,
    mimeType,
    isOpen,
    onClose,
}: DocumentPreviewModalProps) {
    const [probeResult, setProbeResult] = useState<KeyedProbe>({ key: null, status: 'probing' });
    const [imageFailedFor, setImageFailedFor] = useState<number | null>(null);

    useEffect(() => {
        if (!isOpen || documentId === null) return;
        let cancelled = false;

        // Confirms the document still exists (it may have been deleted in another
        // tab) and reports the stored MIME type, which several callers do not have.
        // A HEAD that fails outright is not treated as fatal — we fall back to the
        // caller-supplied hints rather than blocking the preview.
        fetch(documentInlineUrl(documentId), { method: 'HEAD' })
            .then((response) => {
                if (cancelled) return;
                if (response.status === 404) {
                    setProbeResult({ key: documentId, status: 'error', message: 'This document is no longer in the vault.' });
                } else if (response.status === 401 || response.status === 403) {
                    setProbeResult({ key: documentId, status: 'error', message: 'You do not have access to this document.' });
                } else if (!response.ok) {
                    setProbeResult({ key: documentId, status: 'ready', mimeType: null });
                } else {
                    setProbeResult({ key: documentId, status: 'ready', mimeType: response.headers.get('content-type') });
                }
            })
            .catch(() => {
                if (!cancelled) setProbeResult({ key: documentId, status: 'ready', mimeType: null });
            });

        return () => {
            cancelled = true;
        };
    }, [isOpen, documentId]);

    const handleClose = useCallback(() => onClose(), [onClose]);

    if (documentId === null) return null;

    // A result for a different document reads as "still loading" rather than
    // flashing the previous file's preview.
    const probe: ProbeState = probeResult.key === documentId ? probeResult : { status: 'probing' };
    const imageFailed = imageFailedFor === documentId;
    const setImageFailed = () => setImageFailedFor(documentId);

    const serverMime = probe.status === 'ready' ? probe.mimeType : null;
    const kind: DocumentPreviewKind | null =
        probe.status === 'ready' ? resolvePreviewKind(serverMime ?? mimeType, fileName) : null;
    const heading = title?.trim() || fileName?.trim() || `Document #${documentId}`;

    const downloadAction = (
        <a
            href={documentDownloadUrl(documentId)}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground-secondary transition-colors hover:border-primary hover:text-primary"
        >
            Download
        </a>
    );

    return (
        <Modal
            isOpen={isOpen}
            onClose={handleClose}
            title={heading}
            size="fullscreen"
            headerActions={downloadAction}
            resetKey={documentId}
        >
            <div className="flex h-full min-h-[60vh] w-full min-w-0 flex-col p-4">
                {probe.status === 'probing' && (
                    <p className="m-auto text-sm text-foreground-secondary">Loading preview…</p>
                )}

                {probe.status === 'error' && (
                    <PreviewNotice
                        documentId={documentId}
                        heading="Preview unavailable"
                        body={probe.message}
                    />
                )}

                {probe.status === 'ready' && kind === 'pdf' && (
                    // Rendered with pdf.js, NOT the browser's built-in viewer:
                    // the plugin refuses to run under the response's CSP
                    // sandbox and Chrome downloads the file instead (a native
                    // save dialog over the app). See PdfCanvasPreview.
                    <PdfCanvasPreview src={documentInlineUrl(documentId)} heading={heading} />
                )}

                {probe.status === 'ready' && kind === 'image' && !imageFailed && (
                    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 items-start justify-center overflow-auto rounded-lg border border-border bg-background-tertiary p-3">
                        {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded bytes streamed from our own API; next/image cannot optimise them. */}
                        <img
                            src={documentInlineUrl(documentId)}
                            alt={`Preview of ${heading}`}
                            onError={setImageFailed}
                            className="max-w-full object-contain"
                        />
                    </div>
                )}

                {probe.status === 'ready' && (kind === null || imageFailed) && (
                    <PreviewNotice
                        documentId={documentId}
                        heading="Preview isn’t available for this file type"
                        body={
                            imageFailed
                                ? 'The image could not be displayed. Download it to open the file locally.'
                                : 'Only PDFs and PNG, JPEG, GIF, or WebP images can be shown here. Download the file to open it locally.'
                        }
                    />
                )}
            </div>
        </Modal>
    );
}

function PreviewNotice({
    documentId,
    heading,
    body,
}: {
    documentId: number;
    heading: string;
    body: string;
}) {
    return (
        <div className="m-auto max-w-md rounded-lg border border-border bg-background-secondary/30 p-8 text-center">
            <p className="text-sm font-medium text-foreground">{heading}</p>
            <p className="mt-1 text-sm text-foreground-secondary">{body}</p>
            <a
                href={documentDownloadUrl(documentId)}
                className="mt-4 inline-block rounded-md border border-primary/40 px-3 py-1.5 text-sm text-primary transition-colors hover:bg-primary-light"
            >
                Download file
            </a>
        </div>
    );
}

/**
 * Wiring helper for pages that preview one document at a time: keeps the open
 * target in state and renders the modal.
 */
export function useDocumentPreview() {
    const [target, setTarget] = useState<DocumentPreviewTarget | null>(null);
    const close = useCallback(() => setTarget(null), []);
    const open = useCallback((next: DocumentPreviewTarget) => setTarget(next), []);

    const preview = (
        <DocumentPreviewModal
            documentId={target?.documentId ?? null}
            title={target?.title}
            fileName={target?.fileName}
            mimeType={target?.mimeType}
            isOpen={target !== null}
            onClose={close}
        />
    );

    return { open, close, preview, isOpen: target !== null };
}
