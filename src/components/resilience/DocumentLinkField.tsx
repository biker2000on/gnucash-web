'use client';

import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { INPUT } from './ui';
import { DocumentPreviewModal } from '@/components/documents/DocumentPreviewModal';
import { extractErrorMessage } from '@/lib/api-error';
import { Tip } from '@/components/ui/Tooltip';

/** Minimal shape of a document-vault row as returned by GET /api/business/documents. */
export interface VaultDocument {
  id: number;
  title: string;
  fileName: string | null;
  docType: string;
  /** Optional: lets the preview skip its type probe when the caller already knows. */
  mimeType?: string | null;
}

const EDIT_BUTTON =
  'rounded-md border border-border px-2.5 py-1 text-xs text-foreground-secondary transition-colors hover:border-primary hover:text-primary';

/**
 * A link to one vault document. Read mode shows it as a chip that previews the
 * file in a modal (with a download button in the modal header); edit mode adds an
 * unlink control.
 */
export function DocumentChip(props: { doc: VaultDocument | undefined; id: number; onRemove?: () => void }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background-tertiary px-2 py-0.5 text-[11px]">
      <Tip content="Preview document">
      <button
        type="button"
        onClick={() => setPreviewOpen(true)}
        className="text-primary hover:text-primary-hover"
      >
        {props.doc?.title ?? `Document #${props.id}`}
      </button>
      </Tip>
      <DocumentPreviewModal
        documentId={props.id}
        title={props.doc?.title}
        fileName={props.doc?.fileName}
        mimeType={props.doc?.mimeType}
        isOpen={previewOpen}
        onClose={() => setPreviewOpen(false)}
      />
      {props.onRemove && (
        <button type="button" onClick={props.onRemove} className="text-foreground-muted hover:text-negative" aria-label="Unlink document">
          ×
        </button>
      )}
    </span>
  );
}

/**
 * Vault linking for a record: pick an existing document, upload a new one, or
 * unlink. Uploads reuse the document vault's own endpoint
 * (POST /api/business/documents) — there is no parallel upload path — and the
 * new row is reported back so the caller can refresh its vault list.
 *
 * `max` caps how many documents a record can hold (1 for estate documents,
 * unbounded for insurance policies). Extra controls, such as an AI "Parse from
 * document" button, are passed in as `actions`.
 */
export function DocumentLinkField(props: {
  label: string;
  /** Currently linked vault document ids. */
  value: number[];
  onChange: (next: number[]) => void;
  /** All documents in the book's vault, for the picker. */
  vaultDocs: VaultDocument[];
  /** doc_type recorded on upload, e.g. 'estate'. */
  docType: string;
  /** Title for an uploaded file; defaults to the file name. */
  uploadTitle?: (file: File) => string;
  /** Called after a successful upload so the caller can cache the new row. */
  onUploaded?: (doc: VaultDocument) => void;
  onError?: (message: string) => void;
  max?: number;
  actions?: ReactNode;
  hint?: ReactNode;
}) {
  const max = props.max ?? Number.POSITIVE_INFINITY;
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const atCapacity = props.value.length >= max;
  const linkable = props.vaultDocs.filter(doc => !props.value.includes(doc.id));

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('title', props.uploadTitle ? props.uploadTitle(file) : file.name);
      formData.append('doc_type', props.docType);
      const response = await fetch('/api/business/documents', { method: 'POST', body: formData });
      const json = await response.json();
      if (!response.ok) throw new Error(extractErrorMessage(json, 'Upload failed'));
      const doc = json.document as VaultDocument;
      props.onUploaded?.({ id: doc.id, title: doc.title, fileName: doc.fileName, docType: doc.docType, mimeType: doc.mimeType });
      // Replace rather than append when the record only holds one document.
      props.onChange(max === 1 ? [doc.id] : [...props.value, doc.id]);
    } catch (error) {
      props.onError?.(error instanceof Error ? error.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-foreground-secondary">{props.label}</p>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
        className="hidden"
        onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) upload(file);
        }}
      />
      {props.value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {props.value.map(id => (
            <DocumentChip
              key={id}
              id={id}
              doc={props.vaultDocs.find(doc => doc.id === id)}
              onRemove={() => props.onChange(props.value.filter(item => item !== id))}
            />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {linkable.length > 0 && (
          <select
            className={`${INPUT} w-auto`}
            value=""
            onChange={event => {
              const id = Number(event.target.value);
              if (!id) return;
              props.onChange(max === 1 ? [id] : [...props.value, id]);
            }}
          >
            <option value="">{atCapacity ? 'Replace with vault document…' : 'Link vault document…'}</option>
            {linkable.map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}
          </select>
        )}
        <button
          type="button"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
          className={EDIT_BUTTON}
        >
          {uploading ? 'Uploading…' : 'Upload document'}
        </button>
        {props.actions}
      </div>
      {props.hint}
    </div>
  );
}
