/**
 * Shared parsing for user-typed money amounts.
 *
 * `parseAmountStrict` is the single implementation: it accepts what a user
 * realistically types or pastes into a money field (currency symbols,
 * thousands separators, surrounding whitespace) and REJECTS anything that
 * isn't a single finite decimal number — `abc`, `1.2.3`, `12abc`, ``, `NaN`,
 * `Infinity`. Callers that must not book a wrong amount check for null and
 * fail validation; `parseAmount` is the lenient wrapper for display/preview
 * math where a blank or garbage field simply means "nothing entered yet".
 */

/** Parse an amount, or null when the input is not a single valid number. */
export function parseAmountStrict(value: string | number | null | undefined): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value === null || value === undefined) return null;
    // Strip currency symbols, thousands separators and whitespace.
    const cleaned = String(value).replace(/[$£€¥\s,]/g, '');
    // A single optionally-signed decimal number, nothing else.
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
}

/** Lenient parse: same rules, but unparseable input becomes 0. */
export function parseAmount(value: string | number | null | undefined): number {
    const parsed = parseAmountStrict(value);
    return parsed === null ? 0 : parsed;
}
