/**
 * Shared reader for API error responses.
 *
 * The API emits several error-body shapes that accumulated over time:
 *
 *   1. `{ error: string }`                     — the majority of routes
 *   2. `{ errors: [{ field, message }] }`      — `validateTransaction` results
 *   3. `{ error: string, errors: [...] }`      — both (the canonical shape)
 *   4. `{ message: string }`                   — a handful of older routes
 *
 * ...plus bodies that are not JSON at all (proxy/HTML error pages, empty
 * 502/504 bodies). Before this helper every call site hand-rolled its own
 * reader with its own precedence, and several read only one shape — so a
 * server that answered with the *other* shape produced a generic
 * "Failed to save" with the real reason visible only in the server log.
 *
 * Precedence is `error` -> `errors[].message` -> `message` -> caller fallback.
 * `error` wins because routes that send both set `error` to the joined,
 * human-ordered summary of `errors`.
 */

/** A single field-level error entry. Also matches a Zod issue. */
export interface ApiErrorItem {
    field?: string;
    path?: unknown;
    message?: unknown;
}

function asNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Pull a human-readable message out of an already-parsed error body.
 * Exported for direct use when the body is in hand (and for testing).
 */
export function extractErrorMessage(body: unknown, fallback: string): string {
    if (!body || typeof body !== 'object') return fallback;
    const record = body as Record<string, unknown>;

    // 1. `{ error: string }` — and defensively `{ error: { message } }`,
    //    which a few routes produce by passing an Error/parse result through.
    const direct = asNonEmptyString(record.error);
    if (direct) return direct;
    if (record.error && typeof record.error === 'object') {
        const nested = asNonEmptyString((record.error as Record<string, unknown>).message);
        if (nested) return nested;
    }

    // 2. `{ errors: [...] }` — entries are `{ field, message }` or Zod issues.
    if (Array.isArray(record.errors)) {
        const messages = record.errors
            .map(item => {
                if (typeof item === 'string') return asNonEmptyString(item);
                if (item && typeof item === 'object') {
                    return asNonEmptyString((item as ApiErrorItem).message);
                }
                return null;
            })
            .filter((message): message is string => message !== null);
        // Same separator the server uses for its `error` summary
        // (summarizeValidationErrors), so a body carrying only `errors` reads
        // identically to one carrying both.
        if (messages.length > 0) return messages.join('; ');
    }

    // 3. `{ message: string }`
    const message = asNonEmptyString(record.message);
    if (message) return message;

    return fallback;
}

/**
 * Read a failed `fetch` response and return the best available reason.
 * Never throws and never rejects: a non-JSON or unreadable body yields the
 * caller's fallback, so call sites can use the result directly in a toast.
 *
 * The response body is consumed; call this only on the `!res.ok` path.
 */
export async function readErrorBody(response: Response, fallback: string): Promise<string> {
    let body: unknown = null;
    try {
        body = await response.json();
    } catch {
        return fallback;
    }
    return extractErrorMessage(body, fallback);
}

/**
 * Pull the per-field entries out of an error body, keyed by field name.
 *
 * Complements `extractErrorMessage`, which flattens the same list into one
 * banner string. A form that shows only the banner makes the user re-read
 * every field to find the one the server rejected; with this the message can
 * also be parked under the control it is about.
 *
 * Handles both `{ field, message }` (validateTransaction, domain commands) and
 * Zod issues, whose location lives in `path: (string | number)[]`. When two
 * entries name the same field the first wins — servers emit them in the order
 * they want them read.
 */
export function extractFieldErrors(body: unknown): Record<string, string> {
    const result: Record<string, string> = {};
    if (!body || typeof body !== 'object') return result;
    const list = (body as Record<string, unknown>).errors;
    if (!Array.isArray(list)) return result;

    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const entry = item as ApiErrorItem;
        const message = asNonEmptyString(entry.message);
        if (!message) continue;
        let field = asNonEmptyString(entry.field);
        if (!field && Array.isArray(entry.path) && entry.path.length > 0) {
            // Zod: ['splits', 0, 'account_guid'] -> 'splits[0].account_guid'
            field = entry.path.reduce<string>((acc, segment) => {
                if (typeof segment === 'number') return `${acc}[${segment}]`;
                return acc ? `${acc}.${String(segment)}` : String(segment);
            }, '');
        }
        if (!field) continue;
        if (!(field in result)) result[field] = message;
    }
    return result;
}

/**
 * An `Error` that still carries the server's per-field entries.
 *
 * Save handlers throw across a component boundary (the modal fetches, the form
 * renders), so anything not on the `Error` is lost. Without this the field
 * list is read, joined into a banner, and discarded — which is why a rejected
 * post date used to surface only as a sentence at the top of the form.
 */
export class ApiRequestError extends Error {
    readonly fieldErrors: Record<string, string>;
    readonly status?: number;

    constructor(message: string, fieldErrors: Record<string, string> = {}, status?: number) {
        super(message);
        this.name = 'ApiRequestError';
        this.fieldErrors = fieldErrors;
        this.status = status;
    }

    /** Build from an already-parsed error body. */
    static fromBody(body: unknown, fallback: string, status?: number): ApiRequestError {
        return new ApiRequestError(extractErrorMessage(body, fallback), extractFieldErrors(body), status);
    }
}

/**
 * Convenience wrapper: read the error body and throw it as an `Error`.
 * For call sites whose surrounding code already catches and toasts.
 */
export async function throwErrorBody(response: Response, fallback: string): Promise<never> {
    throw new Error(await readErrorBody(response, fallback));
}
