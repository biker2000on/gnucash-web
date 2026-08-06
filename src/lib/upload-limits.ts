/**
 * Upload limits and pre-flight file screening, shared by the server intake
 * pipeline and the browser drop zones.
 *
 * The authority on what may be stored is still the server
 * (`src/lib/services/document-intake.ts`), which re-exports the constants below
 * and re-checks every buffer by magic bytes. This module exists so the client
 * can reject the obvious cases (wrong extension, oversized file) *before*
 * spending an upload round trip, without pulling storage/queue code into the
 * browser bundle — and so both sides quote the same numbers to the user.
 *
 * Nothing here touches Node built-ins: it is safe to import from a
 * `'use client'` component.
 */

export const RECEIPT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const PAYSLIP_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const STATEMENT_MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB

/** Mime types `intakeReceipt` accepts after magic-byte detection. */
export const RECEIPT_ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

/**
 * Extensions matching {@link RECEIPT_ALLOWED_MIME_TYPES}. Needed because a file
 * dragged from some file managers arrives with an empty `File.type`, which
 * would otherwise be screened out before the server ever sees its magic bytes.
 */
export const RECEIPT_ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.pdf'];

/** Value for an `<input type="file" accept="...">` in the receipt pipeline. */
export const RECEIPT_ACCEPT_ATTRIBUTE = 'image/jpeg,image/png,application/pdf';

/** Human-facing size cap, e.g. `10MB`. */
export function formatSizeLimit(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

/** The subset of `File` this module needs — keeps the logic testable. */
export interface ScreenableFile {
  name: string;
  size: number;
  type: string;
}

export interface FileScreenRules {
  maxBytes: number;
  allowedMimeTypes: string[];
  allowedExtensions: string[];
}

export const RECEIPT_SCREEN_RULES: FileScreenRules = {
  maxBytes: RECEIPT_MAX_FILE_SIZE,
  allowedMimeTypes: RECEIPT_ALLOWED_MIME_TYPES,
  allowedExtensions: RECEIPT_ALLOWED_EXTENSIONS,
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Reason this file cannot be uploaded, or `null` if it looks acceptable.
 *
 * Deliberately permissive about type: a file is rejected on type only when we
 * have positive evidence it is wrong. An empty or unrecognised `File.type` with
 * an allowed extension passes here and is settled server-side by magic bytes.
 */
export function screenFile(file: ScreenableFile, rules: FileScreenRules): string | null {
  if (file.size === 0) return 'file is empty';
  if (file.size > rules.maxBytes) return `exceeds ${formatSizeLimit(rules.maxBytes)} limit`;

  const extension = extensionOf(file.name);
  const mime = file.type.toLowerCase();
  const mimeOk = mime !== '' && rules.allowedMimeTypes.includes(mime);
  const extensionOk = extension !== '' && rules.allowedExtensions.includes(extension);
  if (mimeOk || extensionOk) return null;
  if (mime === '' && extension === '') return null; // nothing to judge on; let the server decide

  return 'unsupported file type';
}

export interface FileScreenResult<T extends ScreenableFile> {
  accepted: T[];
  rejected: Array<{ file: T; reason: string }>;
}

/**
 * Split a dropped or picked batch into the files worth uploading and the ones
 * that are already known to fail. One bad file never disqualifies the batch.
 */
export function screenFiles<T extends ScreenableFile>(
  files: Iterable<T>,
  rules: FileScreenRules,
): FileScreenResult<T> {
  const accepted: T[] = [];
  const rejected: Array<{ file: T; reason: string }> = [];
  for (const file of files) {
    const reason = screenFile(file, rules);
    if (reason) rejected.push({ file, reason });
    else accepted.push(file);
  }
  return { accepted, rejected };
}
