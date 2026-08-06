'use client';

import { useCallback, useRef } from 'react';
import { FileDropZone, type FileUploadOutcome } from '@/components/ui/FileDropZone';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import {
  RECEIPT_ACCEPT_ATTRIBUTE,
  RECEIPT_MAX_FILE_SIZE,
  RECEIPT_SCREEN_RULES,
  formatSizeLimit,
} from '@/lib/upload-limits';

export interface ReceiptUploadResult {
  id: number;
  filename: string;
  status: string;
}

/**
 * Upload one file through the receipt intake pipeline
 * (`POST /api/receipts/upload` → `intakeReceipt` → storage + thumbnail + the
 * `ocr-receipt` job → OCR, AI extraction and downstream bill suggestions).
 *
 * One file per request on purpose: the route reports per-file status, but a
 * request-level failure would otherwise take the whole batch down with it.
 * Throws only on transport/HTTP failure; a per-file rejection comes back as a
 * result whose `status` is `error: …`.
 */
export async function uploadReceiptFile(
  file: File,
  transactionGuid?: string | null,
): Promise<ReceiptUploadResult> {
  const body = new FormData();
  if (transactionGuid) body.append('transaction_guid', transactionGuid);
  body.append('files', file);

  const response = await fetch('/api/receipts/upload', { method: 'POST', body });
  const payload = await response.json().catch(() => null) as
    | { results?: ReceiptUploadResult[]; error?: string }
    | null;

  if (!response.ok) {
    throw new Error(payload?.error || `Upload failed (${response.status})`);
  }
  const result = payload?.results?.[0];
  if (!result) throw new Error('Upload failed');
  return result;
}

/** Map an intake result onto the drop zone's per-file outcome. */
export function receiptUploadOutcome(result: ReceiptUploadResult): FileUploadOutcome {
  return result.status === 'uploaded'
    ? { ok: true, message: 'Uploaded' }
    : { ok: false, message: result.status.replace(/^error:\s*/, '') };
}

interface ReceiptUploadZoneProps {
  transactionGuid?: string | null;
  onUploadComplete: (results: ReceiptUploadResult[]) => void;
}

export function ReceiptUploadZone({ transactionGuid, onUploadComplete }: ReceiptUploadZoneProps) {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<((files: FileList | File[]) => void) | null>(null);
  const batchResults = useRef<ReceiptUploadResult[]>([]);
  const isMobile = useIsMobile();

  const upload = useCallback(async (file: File): Promise<FileUploadOutcome> => {
    const result = await uploadReceiptFile(file, transactionGuid);
    batchResults.current.push(result);
    return receiptUploadOutcome(result);
  }, [transactionGuid]);

  const settled = useCallback(() => {
    const results = batchResults.current;
    batchResults.current = [];
    onUploadComplete(results);
  }, [onUploadComplete]);

  return (
    <FileDropZone
      accept={RECEIPT_ACCEPT_ATTRIBUTE}
      rules={RECEIPT_SCREEN_RULES}
      label="Upload receipts"
      prompt={isMobile ? 'Select receipt files' : 'Drag and drop receipts here'}
      hint={`JPEG, PNG, or PDF up to ${formatSizeLimit(RECEIPT_MAX_FILE_SIZE)}. Several files at once are fine.`}
      buttonLabel="Choose receipts"
      onUploadFile={upload}
      onBatchSettled={settled}
      submitRef={submitRef}
    >
      {isMobile && (
        <>
          <button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors duration-150 hover:bg-primary-hover"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
            </svg>
            Take Photo
          </button>
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={event => {
              const file = event.target.files?.[0];
              event.target.value = '';
              // Same screening, upload and status path as a dropped file.
              if (file) submitRef.current?.([file]);
            }}
          />
        </>
      )}
    </FileDropZone>
  );
}
