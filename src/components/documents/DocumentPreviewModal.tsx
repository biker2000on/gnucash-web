'use client';

import { useCallback, useState } from 'react';
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

/**
 * In-browser preview for a vault document.
 *
 * PDFs render in the BROWSER'S OWN viewer via an `<iframe>` of the inline URL
 * — text selection, search, zoom and print for free. The server makes that
 * possible by omitting the CSP `sandbox` for `application/pdf` specifically
 * (see `inlineSecurityHeaders` in lib/document-preview.ts): under `sandbox`
 * the built-in viewer refuses to run and Chrome downloads the file instead,
 * which is why previews spent a while rendered through a vendored pdf.js.
 * The frame carries no `sandbox` attribute for the same reason. Images render
 * as an `<img>`. Anything else (or a document whose type we cannot determine)
 * shows a download prompt rather than an empty frame, so every caller
 * degrades cleanly.
 *
 * The preview renders OPTIMISTICALLY from the caller-supplied MIME type and
 * file name. There used to be a HEAD "probe" of the inline URL first, and it
 * was the direct cause of the 2026-08-21 "preview freezes everything" bug:
 * the download route only exports GET, so Next served the HEAD by running the
 * GET handler — authenticating and reading the ENTIRE object from storage —
 * with no timeout and no abort. One stalled storage read left the modal
 * showing nothing but its backdrop forever. The probe carried no information
 * the preview needs: the vault already knows the MIME/name, and the real byte
 * fetch surfaces 404/403 with better copy anyway.
 */
export function DocumentPreviewModal({
    documentId,
    title,
    fileName,
    mimeType,
    isOpen,
    onClose,
}: DocumentPreviewModalProps) {
    const [imageFailedFor, setImageFailedFor] = useState<number | null>(null);

    const handleClose = useCallback(() => onClose(), [onClose]);

    if (documentId === null) return null;

    const imageFailed = imageFailedFor === documentId;
    const setImageFailed = () => setImageFailedFor(documentId);

    const kind: DocumentPreviewKind | null = resolvePreviewKind(mimeType, fileName);
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
                {kind === 'pdf' && (
                    <iframe
                        src={documentInlineUrl(documentId)}
                        title={`Preview of ${heading}`}
                        className="h-full min-h-0 w-full min-w-0 flex-1 rounded-lg border border-border bg-background-tertiary"
                    />
                )}

                {kind === 'image' && !imageFailed && (
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

                {(kind === null || (kind === 'image' && imageFailed)) && (
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
