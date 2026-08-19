/**
 * Shared builder for schema-validation error responses.
 *
 * Routes used to answer a failed `safeParse` with
 * `{ error: 'Validation failed', errors: parseResult.error.issues }`. The
 * client-side reader (`src/lib/api-error.ts`) resolves `error` first — it is
 * the canonical, human-ordered summary — so that generic string was what every
 * toast displayed, hiding the field-level detail sitting right next to it in
 * `errors`.
 *
 * This mirrors what the transaction write paths already do with
 * `summarizeValidationErrors`: `error` carries a joined human summary and
 * `errors` keeps the machine-readable per-field entries for form UIs.
 */

import { NextResponse } from 'next/server';

/** Structural shape of a Zod issue (kept local so this file stays zod-agnostic). */
export interface ValidationIssueLike {
    path?: readonly PropertyKey[];
    message?: unknown;
}

/** A failed `safeParse` result, or a bare `ZodError`. */
export type ValidationFailureLike =
    | { error: { issues: readonly ValidationIssueLike[] } }
    | { issues: readonly ValidationIssueLike[] }
    | readonly ValidationIssueLike[];

/** Same separator as `summarizeValidationErrors` in `src/lib/validation.ts`. */
const ISSUE_SEPARATOR = '; ';

/** Last-resort text when a failure carries no usable issue at all. */
const GENERIC_SUMMARY = 'Validation failed';

function issuesOf(failure: ValidationFailureLike): readonly ValidationIssueLike[] {
    if (Array.isArray(failure)) return failure as readonly ValidationIssueLike[];
    const record = failure as { error?: { issues?: readonly ValidationIssueLike[] }; issues?: readonly ValidationIssueLike[] };
    if (Array.isArray(record.issues)) return record.issues;
    if (record.error && Array.isArray(record.error.issues)) return record.error.issues;
    return [];
}

/** `"splits.0.value: Required"` — the field path, then the message. */
export function formatValidationIssue(issue: ValidationIssueLike): string {
    const field = Array.isArray(issue.path)
        ? issue.path
              .filter(segment => segment !== undefined && segment !== null && segment !== '')
              .map(segment => String(segment))
              .join('.')
        : '';
    const raw = typeof issue.message === 'string' ? issue.message.trim() : '';
    const message = raw === '' ? 'Invalid value' : raw;
    return field === '' ? message : `${field}: ${message}`;
}

/** Join every issue into the single human-readable string routes return as `error`. */
export function summarizeValidationIssues(failure: ValidationFailureLike): string {
    const summary = issuesOf(failure).map(formatValidationIssue).join(ISSUE_SEPARATOR);
    return summary === '' ? GENERIC_SUMMARY : summary;
}

/**
 * Build the 400 response for a failed schema parse: a named-field summary in
 * `error` plus the raw issues in `errors` for field-level form rendering.
 */
export function validationErrorResponse(failure: ValidationFailureLike, status = 400): NextResponse {
    return NextResponse.json(
        { error: summarizeValidationIssues(failure), errors: issuesOf(failure) },
        { status },
    );
}
