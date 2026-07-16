/**
 * Locale-aware number/date parsing for importers (pure — no database access).
 *
 * Every CSV importer (QuickBooks, Mint, YNAB, Monarch, ...) funnels its cell
 * parsing through these helpers so US ("1,234.56", MM/DD/YYYY) and European
 * ("1.234,56", DD/MM/YYYY) exports are handled uniformly.
 *
 * Conventions (kept bit-identical with the original QBO parser at the US
 * defaults — its tests pin this behavior):
 *
 *   - blank / "-" / "--" amounts parse to 0 (QBO renders empty cells that way)
 *   - "(45.10)" and "-45.10" are negative; currency symbols and spaces are
 *     stripped; unparseable text returns null
 *   - numeric dates are STRICT for the configured order: "13/45/2025" is null
 *     under month-first — there is no silent day-first fallback (previews use
 *     couldBeDayFirst() to warn about ambiguous files instead)
 */

export interface ImportLocale {
    /** Decimal separator: '.' → 1,234.56 (US), ',' → 1.234,56 (EU) */
    decimal: '.' | ',';
    /** Numeric dates are DD/MM/YYYY when true, MM/DD/YYYY when false */
    dayFirst: boolean;
}

export type ImportLocaleId = 'us' | 'eu';

export const IMPORT_LOCALES: Record<ImportLocaleId, ImportLocale> = {
    us: { decimal: '.', dayFirst: false },
    eu: { decimal: ',', dayFirst: true },
};

export const DEFAULT_LOCALE: ImportLocale = IMPORT_LOCALES.us;

/** Resolve a locale id from user input; anything unknown falls back to US. */
export function resolveImportLocale(id: string | null | undefined): ImportLocale {
    return id === 'eu' ? IMPORT_LOCALES.eu : IMPORT_LOCALES.us;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Numbers                                                              */
/* ------------------------------------------------------------------ */

/**
 * Parse an amount cell with a configurable decimal separator.
 *
 * Handles thousands separators, currency symbols (any non-digit junk),
 * leading minus, and accounting parentheses. Returns 0 for blank cells,
 * null for unparseable text. Rounded to 2 decimals.
 */
export function parseLocaleNumber(
    raw: string,
    opts?: { decimal?: '.' | ',' }
): number | null {
    const decimal = opts?.decimal ?? '.';
    let s = raw.trim();
    if (s === '' || s === '-' || s === '--') return 0;

    let sign = 1;
    if (/^\(.*\)$/.test(s)) {
        sign = -1;
        s = s.slice(1, -1);
    }
    if (s.startsWith('-')) sign *= -1;

    // Keep digits + the decimal separator; everything else (thousands
    // separators, $, €, spaces, NBSP, letters) is stripped.
    if (decimal === ',') {
        s = s.replace(/[^0-9,]/g, '').replace(',', '.');
    } else {
        s = s.replace(/[^0-9.]/g, '');
    }
    if (s === '' || s === '.') return null;

    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return round2(sign * n);
}

/* ------------------------------------------------------------------ */
/* Dates                                                                */
/* ------------------------------------------------------------------ */

const MONTHS: Record<string, number> = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
};

function validIso(y: number, mo: number, d: number): string | null {
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function expandYear(raw: string): number {
    let y = Number(raw);
    if (raw.length === 2) y += y >= 70 ? 1900 : 2000;
    return y;
}

const NUMERIC_DATE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/;

/**
 * Parse a date cell to ISO YYYY-MM-DD, or null when unrecognized.
 *
 * Accepted forms:
 *   - ISO: YYYY-MM-DD / YYYY/MM/DD (always year-first, locale-independent)
 *   - Numeric: MM/DD/YYYY or DD/MM/YYYY per `dayFirst` ("/", "-", "." all
 *     accepted as separators; 2-digit years expand with a 1970 pivot)
 *   - Month name: "5 Jan 2025", "05 January 2025", "Jan 5, 2025",
 *     "January 5 2025" (locale-independent)
 */
export function parseLocaleDate(
    raw: string,
    opts?: { dayFirst?: boolean }
): string | null {
    const dayFirst = opts?.dayFirst ?? false;
    const s = raw.trim();
    if (!s) return null;

    // ISO: YYYY-MM-DD (also YYYY/MM/DD)
    let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (m) {
        const [, y, mo, d] = m;
        return validIso(Number(y), Number(mo), Number(d));
    }

    // Numeric: MM/DD/YYYY or DD/MM/YYYY (strict for the configured order)
    m = s.match(NUMERIC_DATE);
    if (m) {
        const [, a, b, yRaw] = m;
        const y = expandYear(yRaw);
        return dayFirst
            ? validIso(y, Number(b), Number(a))
            : validIso(y, Number(a), Number(b));
    }

    // "5 Jan 2025" / "05 January 2025"
    m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{2,4})$/);
    if (m) {
        const mo = MONTHS[m[2].toLowerCase()];
        if (!mo) return null;
        return validIso(expandYear(m[3]), mo, Number(m[1]));
    }

    // "Jan 5, 2025" / "January 5 2025"
    m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{2,4})$/);
    if (m) {
        const mo = MONTHS[m[1].toLowerCase()];
        if (!mo) return null;
        return validIso(expandYear(m[3]), mo, Number(m[2]));
    }

    return null;
}

/**
 * Ambiguity detector for previews: true when a numeric date string parses to
 * DIFFERENT valid dates under day-first vs month-first (e.g. "03/04/2025").
 * Unambiguous strings ("15/04/2025" can only be day-first; "04/04/2025" is
 * the same either way; ISO and month-name dates never) return false.
 */
export function couldBeDayFirst(raw: string): boolean {
    const m = raw.trim().match(NUMERIC_DATE);
    if (!m) return false;
    const [, a, b, yRaw] = m;
    const y = expandYear(yRaw);
    const monthFirst = validIso(y, Number(a), Number(b));
    const dayFirst = validIso(y, Number(b), Number(a));
    return monthFirst !== null && dayFirst !== null && monthFirst !== dayFirst;
}
