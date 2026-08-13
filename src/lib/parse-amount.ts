/**
 * Strict parsing for user-typed money amounts (transaction entry).
 *
 * The shape of the ORIGINAL string is validated first and normalized only
 * afterwards. Normalizing first — stripping symbols and separators and then
 * checking what is left — silently repairs malformed input into a different
 * number: "1,234,56" would become 123456 and "$1$234" would become 1234.
 * Booking those is worse than rejecting them, so anything that is not one
 * well-formed number is rejected and the caller fails validation.
 *
 * NOTE: `parseAmount` in src/components/business/invoice-ui.ts deliberately
 * keeps its own lenient, parseFloat-based parser. Invoice/bill/voucher drafts
 * have relied on that prefix-parse behaviour (e.g. "12abc" → 12) since they
 * shipped; tightening it is a separate, deliberate change and is out of scope
 * here.
 */

/**
 * One optionally-signed amount:
 *   - one optional currency symbol, before or after the sign (never both sides)
 *   - digits either ungrouped (1234) or in well-formed 3-digit groups (1,234)
 *   - an optional decimal part, and a bare leading point (.5)
 * Interior spaces, extra symbols and malformed groups fail to match.
 */
const AMOUNT_PATTERN =
    /^(?:[+-]?[$£€¥]?|[$£€¥][+-]?)(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d*)?$/;

/**
 * Parse an amount, or null when the input is not a single valid number.
 * Rejects `abc`, `12abc`, `1.2.3`, `1,23`, `1,234,56`, `1 2 3`, `$1$234`,
 * empty, `NaN` and `Infinity`.
 */
export function parseAmountStrict(value: string | number | null | undefined): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value === null || value === undefined) return null;

    // Only surrounding whitespace is forgiven; the rest is validated as typed.
    const trimmed = String(value).trim();
    if (!AMOUNT_PATTERN.test(trimmed)) return null;
    // The pattern allows an empty digit part ("", "$", "-.") — require a digit.
    if (!/\d/.test(trimmed)) return null;

    // Shape is known good, so normalization cannot change the value's meaning.
    const n = Number(trimmed.replace(/[$£€¥,]/g, ''));
    return Number.isFinite(n) ? n : null;
}
