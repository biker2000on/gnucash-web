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
 * Convenience wrapper: read the error body and throw it as an `Error`.
 * For call sites whose surrounding code already catches and toasts.
 */
export async function throwErrorBody(response: Response, fallback: string): Promise<never> {
    throw new Error(await readErrorBody(response, fallback));
}
