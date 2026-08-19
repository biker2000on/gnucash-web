'use client';

import type { ReactNode } from 'react';

/**
 * App-wide form primitives.
 *
 * Edit forms are not data tables. DESIGN.md's data-dense direction applies to
 * ledgers, reports and metric tiles — applying it to input forms produces
 * cramped multi-column grids of ~150px fields that read as a spreadsheet.
 * These primitives encode the rules that keep forms readable; prefer them over
 * hand-rolled grids and label spans.
 */

/**
 * The single input recipe. Radius `md` (6px) is the only radius on DESIGN.md's
 * scale for a control this size — do not hand-roll `rounded-lg`/`rounded-xl`
 * inputs, and do not invent a second padding/typography pair. `<select>` and
 * `<textarea>` extend this constant rather than restating it.
 */
export const INPUT =
  'w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none transition-colors hover:border-border-hover focus:border-primary';

/** `<select>` recipe: the input recipe plus the pointer affordance. */
export const SELECT = `${INPUT} cursor-pointer`;

/** `<textarea>` recipe: the input recipe, no drag-resize (it breaks form grids). */
export const TEXTAREA = `${INPUT} resize-none`;

/**
 * Invalid-control modifier. Uses `--error` (form validation), never
 * `--negative` — `--negative` is reserved for money that is below zero.
 * See the token contract at the top of `src/app/globals.css`.
 */
export const INPUT_INVALID = 'border-error ring-1 ring-error/30';

/** Inline, per-field validation message under a control. */
export const FIELD_ERROR = 'mt-1 text-xs text-error';

/**
 * Inline validation message, rendered directly under the control it is about.
 *
 * A form that reports failures only in a banner at the top makes the user
 * re-read every field to find the rejected one. Give the node an `id` and
 * point the control's `aria-describedby` at it so the message is also part of
 * the control's accessible description — the banner (an `ErrorLiveRegion`) is
 * what announces the failure, this is what says *where*.
 */
export function FieldError({ id, message }: { id?: string; message?: string | null }) {
  if (!message) return null;
  return (
    <p id={id} className={FIELD_ERROR}>
      {message}
    </p>
  );
}

/** Build a control's class list from the shared recipe. */
export function inputClass(opts?: { base?: string; invalid?: boolean; extra?: string }): string {
  const base = opts?.base ?? INPUT;
  return [base, opts?.invalid ? INPUT_INVALID : '', opts?.extra ?? ''].filter(Boolean).join(' ');
}

/**
 * Field label. 12px is the floor of DESIGN.md's type scale — do not go below
 * it for anything a user has to read while typing. (Badges, chips and keyboard
 * hints are a different case and may stay smaller.)
 */
export const LABEL = 'mb-1.5 block text-xs font-semibold uppercase tracking-wider text-foreground-secondary';

/** Tabular figures, so digits align in columns. */
export const TNUM = { fontFeatureSettings: "'tnum'" };

/**
 * Form-grid rule for edit forms.
 *
 * - Mobile is ALWAYS a single column. Two text inputs side by side on a phone
 *   are unusable, so `grid-cols-1` is the non-negotiable base.
 * - Edit forms cap at 2 columns on `sm` and 3 on `lg`. No 4-, 5-, or
 *   8-column input rows: if a record has more fields than fit, it wraps onto
 *   another row. Vertical space is free, horizontal is not.
 * - Minimum comfortable field width is ~200px, which is what the 1/2/3 ramp
 *   yields inside a 1400px page container.
 * - Row actions (delete/remove) do NOT belong in here — put them in the
 *   record's header row or a trailing row so they stop stealing a column.
 *
 * Metric tiles, computed result tables and read-mode summaries are NOT edit
 * forms and may stay dense (`lg:grid-cols-4` is fine there).
 */
export function FieldGrid(props: {
  children: ReactNode;
  /** Widest column count. `2` for short forms, `3` (default) for longer ones. */
  cols?: 2 | 3;
  className?: string;
}) {
  const ramp = props.cols === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3';
  return <div className={`grid grid-cols-1 gap-4 ${ramp}${props.className ? ` ${props.className}` : ''}`}>{props.children}</div>;
}

/**
 * A single editable record: a title row that owns the destructive action, then
 * the fields. Keeping the remove control up here is what lets `FieldGrid` stay
 * a pure input grid instead of surrendering a column to a button.
 */
export function RecordCard(props: {
  title: ReactNode;
  removeLabel: string;
  onRemove: () => void;
  children: ReactNode;
}) {
  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-foreground">{props.title}</span>
        <button
          type="button"
          onClick={props.onRemove}
          className="text-xs text-foreground-muted transition-colors hover:text-negative"
        >
          {props.removeLabel}
        </button>
      </div>
      {props.children}
    </div>
  );
}

/** Labelled form field. Pass the control as `children`. */
export function Field(props: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={props.className}>
      <span className={LABEL}>{props.label}</span>
      {props.children}
    </label>
  );
}
