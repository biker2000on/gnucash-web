'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  screenFiles,
  type FileScreenRules,
} from '@/lib/upload-limits';

/**
 * App-wide file drop zone.
 *
 * One place owns the fiddly parts of drag-and-drop so feature surfaces do not
 * each re-derive them:
 *
 * - `dragover` is `preventDefault`ed, otherwise the browser navigates away from
 *   the app and opens the dropped file.
 * - `dragenter`/`dragleave` are counted rather than toggled, so moving the
 *   pointer across a child element does not flicker the highlight off.
 * - The batch is screened per file and uploaded per file, so one oversized or
 *   unsupported file cannot sink the rest of the drop.
 * - The interaction is a real `<button>` plus a native file input, not a
 *   `div` with a click handler: keyboard and screen-reader users get the
 *   platform file picker, and the drop surface carries an accessible label.
 *
 * The caller supplies `onUploadFile`, which uploads exactly one file and
 * resolves with its outcome. Rejecting is treated the same as `{ ok: false }`.
 */

export interface FileUploadOutcome {
  ok: boolean;
  /** Short reason shown next to the filename when `ok` is false. */
  message?: string;
}

type ItemStatus = 'queued' | 'uploading' | 'success' | 'error';

interface UploadItem {
  key: string;
  filename: string;
  status: ItemStatus;
  message?: string;
}

export interface FileDropZoneProps {
  /** `accept` attribute for the file input. */
  accept: string;
  /** Client-side screen; must mirror what the server route already enforces. */
  rules: FileScreenRules;
  /** Accessible name for the drop surface, e.g. "Upload utility bills". */
  label: string;
  /** Visible prompt inside the zone. */
  prompt: string;
  /** Visible constraint hint, e.g. "JPEG, PNG, or PDF up to 10MB". */
  hint: string;
  /** Text of the focusable picker control. */
  buttonLabel?: string;
  /** Uploads one file. Never called for files the screen already rejected. */
  onUploadFile: (file: File) => Promise<FileUploadOutcome>;
  /** Called once after every file in a batch has settled. */
  onBatchSettled?: (summary: { succeeded: number; failed: number }) => void;
  multiple?: boolean;
  disabled?: boolean;
  /** Optional icon; a generic upload glyph is used when omitted. */
  icon?: ReactNode;
  /** Extra controls rendered under the zone (e.g. a mobile camera button). */
  children?: ReactNode;
  /**
   * Filled with a submit callback so an external control rendered via
   * `children` (a camera input, say) can feed files through the same
   * screening, upload and per-file status path.
   */
  submitRef?: RefObject<((files: FileList | File[]) => void) | null>;
}

const UPLOAD_ICON = (
  <svg className="h-8 w-8 text-foreground-muted" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
  </svg>
);

export function FileDropZone(props: FileDropZoneProps) {
  const { onUploadFile, onBatchSettled, rules, disabled } = props;
  const [dragging, setDragging] = useState(false);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // dragenter/dragleave fire for every descendant. Counting them (instead of
  // clearing on the first dragleave) keeps the highlight steady while the
  // pointer travels over the icon and the button.
  const dragDepth = useRef(0);
  const batchSeq = useRef(0);
  const hintId = useId();

  const openPicker = useCallback(() => {
    if (!disabled) inputRef.current?.click();
  }, [disabled]);

  const handleFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    const { accepted, rejected } = screenFiles(files, rules);
    const batch = ++batchSeq.current;
    const keyByFile = new Map(files.map((file, index) => [file, `${batch}-${index}`]));
    const reasonByFile = new Map(rejected.map(entry => [entry.file, entry.reason]));

    // Seed the list in drop order so the user sees every file immediately,
    // including the ones that never leave the browser.
    setItems(files.map(file => {
      const reason = reasonByFile.get(file);
      return {
        key: keyByFile.get(file)!,
        filename: file.name,
        status: reason ? 'error' : 'queued',
        message: reason,
      };
    }));

    const patch = (key: string, next: Partial<UploadItem>) =>
      setItems(current => current.map(item => (item.key === key ? { ...item, ...next } : item)));

    let succeeded = 0;
    let failed = rejected.length;

    setBusy(true);
    try {
      // Sequential: each file gets its own request, so a failure is contained
      // to that file and progress reads in a predictable order.
      for (const file of accepted) {
        const key = keyByFile.get(file)!;
        patch(key, { status: 'uploading', message: undefined });
        try {
          const outcome = await onUploadFile(file);
          if (outcome.ok) {
            succeeded++;
            patch(key, { status: 'success', message: outcome.message });
          } else {
            failed++;
            patch(key, { status: 'error', message: outcome.message ?? 'upload failed' });
          }
        } catch (error) {
          failed++;
          patch(key, {
            status: 'error',
            message: error instanceof Error ? error.message : 'upload failed',
          });
        }
      }
    } finally {
      setBusy(false);
    }

    onBatchSettled?.({ succeeded, failed });
  }, [onUploadFile, onBatchSettled, rules]);

  const submitRef = props.submitRef;
  useEffect(() => {
    if (!submitRef) return;
    submitRef.current = files => void handleFiles(files);
    return () => { submitRef.current = null; };
  }, [submitRef, handleFiles]);

  return (
    <div className="space-y-3">
      <div
        onDragEnter={event => {
          event.preventDefault();
          if (disabled) return;
          dragDepth.current++;
          setDragging(true);
        }}
        onDragOver={event => {
          // Without this the drop is handed to the browser, which navigates
          // the tab to the dropped file.
          event.preventDefault();
          if (!disabled && event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={event => {
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={event => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (disabled) return;
          void handleFiles(event.dataTransfer.files);
        }}
        onClick={openPicker}
        role="group"
        aria-label={props.label}
        aria-busy={busy}
        className={`flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-6 text-center transition-colors duration-150 ${
          disabled
            ? 'cursor-not-allowed border-border opacity-60'
            : dragging
              ? 'cursor-copy border-primary bg-primary-light'
              : 'cursor-pointer border-border hover:border-border-hover hover:bg-surface-hover'
        }`}
      >
        {props.icon ?? UPLOAD_ICON}
        <div>
          <p className="text-sm text-foreground-secondary">{props.prompt}</p>
          <p id={hintId} className="mt-1 text-xs text-foreground-muted">{props.hint}</p>
        </div>
        <button
          type="button"
          disabled={disabled}
          aria-describedby={hintId}
          onClick={event => {
            // The wrapper opens the picker too; without this the click would
            // bubble and open it a second time.
            event.stopPropagation();
            openPicker();
          }}
          className="rounded-md border border-border px-3 py-2 text-sm font-semibold text-primary transition-colors duration-150 hover:border-border-hover disabled:opacity-50"
        >
          {props.buttonLabel ?? 'Choose files'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={props.accept}
          multiple={props.multiple ?? true}
          tabIndex={-1}
          aria-hidden="true"
          className="hidden"
          onChange={event => {
            const files = event.target.files;
            if (files) void handleFiles(files);
            // Reset so picking the same file twice in a row still fires.
            event.target.value = '';
          }}
        />
      </div>

      {props.children}

      {items.length > 0 && (
        <ul className="space-y-1" aria-live="polite">
          {items.map(item => (
            <li
              key={item.key}
              className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                item.status === 'success'
                  ? 'border-border text-positive'
                  : item.status === 'error'
                    ? 'border-error/40 text-error'
                    : 'border-border text-foreground-secondary'
              }`}
            >
              <span aria-hidden="true" className="shrink-0 font-mono text-xs">
                {item.status === 'success' ? '✓' : item.status === 'error' ? '✕' : '…'}
              </span>
              <span className="truncate">{item.filename}</span>
              <span className="ml-auto shrink-0 text-xs">
                {item.status === 'uploading'
                  ? 'Uploading…'
                  : item.status === 'queued'
                    ? 'Waiting'
                    : item.message ?? (item.status === 'success' ? 'Uploaded' : 'Failed')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
