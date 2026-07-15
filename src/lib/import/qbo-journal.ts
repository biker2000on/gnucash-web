/**
 * QuickBooks Online export parsers (pure — no database access).
 *
 * Two inputs, both standard QBO exports:
 *
 * 1. Journal report CSV (Reports → Journal → Export to CSV). Every posted
 *    transaction appears as a group of debit/credit rows. The export has
 *    preamble rows (company name, "Journal", date range) before the header,
 *    per-transaction total rows, and a grand-total row — all handled here.
 *
 * 2. Chart of Accounts CSV (gear → Chart of accounts → Run report → Export).
 *    Gives QBO Type / Detail type per account for accurate GnuCash typing.
 *
 * Sign convention: Debit → positive split value, Credit → negative
 * (GnuCash convention; a balanced transaction sums to zero).
 */

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export interface QboJournalLine {
    /** QBO colon path, e.g. "Expenses:Office Supplies" (same idiom as GnuCash) */
    accountPath: string;
    /** Debit positive, credit negative, rounded to 2 decimals */
    amount: number;
    memo: string;
    /** 1-based row number in the original file (for error reporting) */
    row: number;
}

export interface QboJournalTransaction {
    /** ISO date YYYY-MM-DD */
    date: string;
    /** QBO "Transaction Type" (Invoice, Payment, Journal Entry, ...) */
    type: string;
    num: string;
    /** QBO "Name" — customer/vendor/payee */
    name: string;
    /** Memo of the first line (QBO repeats the txn memo per row) */
    memo: string;
    lines: QboJournalLine[];
    /** 1-based row number where the transaction starts */
    startRow: number;
}

export interface QboParseError {
    row: number;
    message: string;
}

export interface QboJournalParseResult {
    transactions: QboJournalTransaction[];
    /** Distinct account paths referenced by importable transactions, sorted */
    accountsSeen: string[];
    /** Imbalanced / unparseable transactions — excluded from `transactions` */
    errors: QboParseError[];
    warnings: string[];
    dateRange: { start: string; end: string } | null;
    /** Company name from the report preamble, when present */
    companyName: string | null;
    /** Total data rows examined (excludes preamble + header) */
    rowsRead: number;
}

export interface QboCoaAccount {
    /** Colon path as exported ("Parent:Sub") or plain name */
    fullName: string;
    qboType: string;
    detailType: string;
    /** Mapped GnuCash type, or null when the QBO type is unrecognized */
    gnucashType: string | null;
}

export interface QboCoaParseResult {
    accounts: QboCoaAccount[];
    warnings: string[];
    errors: QboParseError[];
}

export type AccountTypeSource = 'override' | 'coa' | 'inferred' | 'default';

export interface ResolvedAccount {
    path: string;
    gnucashType: string;
    source: AccountTypeSource;
}

/* ------------------------------------------------------------------ */
/* CSV primitives                                                       */
/* ------------------------------------------------------------------ */

/**
 * Split CSV content into rows of fields (RFC-4180-ish: quoted fields may
 * contain commas, escaped quotes, and newlines). Keeps EVERY physical row,
 * including blank ones, so indices map back to original row numbers.
 */
export function splitCsvRows(content: string): string[][] {
    // Strip UTF-8 BOM
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

    const rows: string[][] = [];
    let fields: string[] = [];
    let current = '';
    let inQuotes = false;

    const endField = () => {
        fields.push(current);
        current = '';
    };
    const endRow = () => {
        endField();
        rows.push(fields);
        fields = [];
    };

    for (let i = 0; i < content.length; i++) {
        const ch = content[i];
        if (inQuotes) {
            if (ch === '"') {
                if (content[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                current += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            endField();
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && content[i + 1] === '\n') i++;
            endRow();
        } else {
            current += ch;
        }
    }
    if (current.length > 0 || fields.length > 0) endRow();

    return rows.map((r) => r.map((f) => f.trim()));
}

/**
 * Parse a QBO-exported amount cell. Handles thousands commas, currency
 * symbols, leading minus, and accounting parentheses for negatives.
 * Returns 0 for blank, null for unparseable text.
 */
export function parseQboAmount(raw: string): number | null {
    let s = raw.trim();
    if (s === '' || s === '-' || s === '--') return 0;

    let sign = 1;
    if (/^\(.*\)$/.test(s)) {
        sign = -1;
        s = s.slice(1, -1);
    }
    if (s.startsWith('-')) sign *= -1;

    // Strip everything except digits and decimal point (commas, $, €, spaces, NBSP)
    s = s.replace(/[^0-9.]/g, '');
    if (s === '' || s === '.') return null;

    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return round2(sign * n);
}

/** Parse MM/DD/YYYY (primary), M/D/YYYY, MM-DD-YYYY, or YYYY-MM-DD → ISO date. */
export function parseQboDate(raw: string): string | null {
    const s = raw.trim();
    if (!s) return null;

    // ISO: YYYY-MM-DD (also YYYY/MM/DD)
    let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (m) {
        const [, y, mo, d] = m;
        return validIso(Number(y), Number(mo), Number(d));
    }

    // US: MM/DD/YYYY or MM-DD-YYYY (2-digit years tolerated)
    m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
    if (m) {
        const [, mo, d, yRaw] = m;
        let y = Number(yRaw);
        if (yRaw.length === 2) y += y >= 70 ? 1900 : 2000;
        return validIso(y, Number(mo), Number(d));
    }

    return null;
}

function validIso(y: number, mo: number, d: number): string | null {
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/**
 * Canonicalize a QBO colon path: trim each segment and drop empty ones, so
 * "Parent: Sub" and "Parent:Sub" resolve to the same account everywhere
 * (parser, type resolution, and the commit-time guid lookup).
 */
export function canonicalAccountPath(raw: string): string {
    return raw
        .split(':')
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .join(':');
}

function normHeader(cell: string): string {
    return cell.trim().toLowerCase().replace(/\s+/g, ' ');
}

/* ------------------------------------------------------------------ */
/* Journal parser                                                       */
/* ------------------------------------------------------------------ */

interface JournalColumns {
    date: number;
    type: number;
    num: number;
    name: number;
    memo: number;
    account: number;
    debit: number;
    credit: number;
    class: number;
    location: number;
}

/** Detect the Journal header row and map its columns. */
function detectJournalHeader(cells: string[]): JournalColumns | null {
    const norm = cells.map(normHeader);
    const find = (...matchers: Array<string | ((c: string) => boolean)>): number => {
        for (const m of matchers) {
            const idx = norm.findIndex((c) =>
                typeof m === 'string' ? c === m : c !== '' && m(c)
            );
            if (idx >= 0) return idx;
        }
        return -1;
    };

    const date = find('date', 'transaction date', (c) => c.endsWith('date'));
    const debit = find('debit', (c) => c.includes('debit'));
    const credit = find('credit', (c) => c.includes('credit'));
    const account = find(
        'full account name',
        'account',
        'account name',
        (c) => c.includes('account')
    );
    if (date < 0 || debit < 0 || credit < 0 || account < 0) return null;

    return {
        date,
        debit,
        credit,
        account,
        type: find('transaction type', 'type', (c) => c.includes('transaction type')),
        num: find('num', 'no.', 'no', '#', 'number'),
        name: find('name', (c) => c === 'payee' || c === 'vendor' || c === 'customer'),
        memo: find('memo/description', 'memo', 'description', (c) => c.includes('memo')),
        class: find('class'),
        location: find('location'),
    };
}

/** Company name = first meaningful preamble row that isn't the report title or date range. */
function extractCompanyName(preambleRows: string[][]): string | null {
    for (const row of preambleRows) {
        const text = row.filter((c) => c !== '').join(' ').trim();
        if (!text) continue;
        const lower = text.toLowerCase();
        if (lower === 'journal' || lower === 'journal report') continue;
        // Date-range-ish rows: "January 1 - December 31, 2025", "All Dates"
        if (lower === 'all dates') continue;
        if (/\d{4}/.test(text) && /[-–—]|to /i.test(text)) continue;
        if (/^(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(text)) continue;
        return text;
    }
    return null;
}

const MAX_HEADER_SCAN_ROWS = 25;

export function parseQboJournalCsv(content: string): QboJournalParseResult {
    const rows = splitCsvRows(content);
    const warnings: string[] = [];
    const errors: QboParseError[] = [];

    // 1. Locate the header row
    let headerIdx = -1;
    let cols: JournalColumns | null = null;
    for (let i = 0; i < Math.min(rows.length, MAX_HEADER_SCAN_ROWS); i++) {
        const detected = detectJournalHeader(rows[i]);
        if (detected) {
            headerIdx = i;
            cols = detected;
            break;
        }
    }
    if (headerIdx < 0 || !cols) {
        return {
            transactions: [],
            accountsSeen: [],
            errors: [
                {
                    row: 1,
                    message:
                        'Could not find the Journal header row (expected columns like Date, Transaction Type, Account, Debit, Credit). ' +
                        'Make sure this is a QuickBooks Online Journal report exported as CSV.',
                },
            ],
            warnings,
            dateRange: null,
            companyName: extractCompanyName(rows.slice(0, Math.min(rows.length, MAX_HEADER_SCAN_ROWS))),
            rowsRead: 0,
        };
    }

    const companyName = extractCompanyName(rows.slice(0, headerIdx));
    if (cols.memo < 0) warnings.push('No Memo/Description column found; memos will be empty.');
    if (cols.name < 0) warnings.push('No Name column found; descriptions will fall back to memos.');

    const cell = (row: string[], idx: number): string =>
        idx >= 0 && idx < row.length ? row[idx] : '';

    // 2. Group rows into transactions
    const finished: QboJournalTransaction[] = [];
    let current: QboJournalTransaction | null = null;
    let currentBad = false; // an unparseable amount poisons the whole transaction
    let rowsRead = 0;

    const finishCurrent = () => {
        if (!current) return;
        const txn = current;
        current = null;
        const bad = currentBad;
        currentBad = false;

        if (txn.lines.length === 0) {
            // Date row that contributed no account lines — report artifact
            return;
        }
        if (bad) return; // error already recorded

        const sum = round2(txn.lines.reduce((s, l) => s + l.amount, 0));
        if (Math.abs(sum) > 0.01) {
            errors.push({
                row: txn.startRow,
                message:
                    `Transaction on ${txn.date}${txn.name ? ` ("${txn.name}")` : ''} does not balance: ` +
                    `debits and credits differ by ${sum.toFixed(2)}.`,
            });
            return;
        }
        finished.push(txn);
    };

    for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 1; // 1-based, matches the file
        const isBlank = row.every((c) => c === '');
        if (isBlank) continue;
        rowsRead++;

        const dateRaw = cell(row, cols.date);
        const accountRaw = cell(row, cols.account);

        if (dateRaw !== '') {
            // New transaction starts
            finishCurrent();
            const iso = parseQboDate(dateRaw);
            if (!iso) {
                errors.push({ row: rowNum, message: `Unrecognized date "${dateRaw}".` });
                current = null;
                continue;
            }
            current = {
                date: iso,
                type: cell(row, cols.type),
                num: cell(row, cols.num),
                name: cell(row, cols.name),
                memo: cell(row, cols.memo),
                lines: [],
                startRow: rowNum,
            };
        } else if (!current) {
            // Continuation row with no open transaction: grand total / artifact
            continue;
        }

        // Total rows (per-transaction or report grand total): no account,
        // or an explicit "Total ..." label in the account column.
        if (accountRaw === '' || /^total\b/i.test(accountRaw)) continue;
        const accountPath = canonicalAccountPath(accountRaw);
        if (accountPath === '') continue;

        const debitRaw = cell(row, cols.debit);
        const creditRaw = cell(row, cols.credit);
        const debit = parseQboAmount(debitRaw);
        const credit = parseQboAmount(creditRaw);
        if (debit === null || credit === null) {
            if (!currentBad) {
                errors.push({
                    row: rowNum,
                    message: `Could not parse amount "${debit === null ? debitRaw : creditRaw}" for account "${accountRaw}".`,
                });
            }
            currentBad = true;
            continue;
        }

        const amount = round2(debit - credit);

        const memoParts: string[] = [];
        const lineMemo = cell(row, cols.memo);
        if (lineMemo) memoParts.push(lineMemo);
        const klass = cell(row, cols.class);
        if (klass) memoParts.push(`Class: ${klass}`);
        const location = cell(row, cols.location);
        if (location) memoParts.push(`Location: ${location}`);

        current!.lines.push({
            accountPath,
            amount,
            memo: memoParts.join(' | '),
            row: rowNum,
        });
        // First line's metadata backfills blank txn-level fields (some exports
        // leave Name/Memo only on specific rows).
        if (!current!.memo && lineMemo) current!.memo = lineMemo;
        if (!current!.name) {
            const n = cell(row, cols.name);
            if (n) current!.name = n;
        }
    }
    finishCurrent();

    // 3. Aggregate
    const accountsSeen = Array.from(
        new Set(finished.flatMap((t) => t.lines.map((l) => l.accountPath)))
    ).sort((a, b) => a.localeCompare(b));

    let dateRange: QboJournalParseResult['dateRange'] = null;
    if (finished.length > 0) {
        let start = finished[0].date;
        let end = finished[0].date;
        for (const t of finished) {
            if (t.date < start) start = t.date;
            if (t.date > end) end = t.date;
        }
        dateRange = { start, end };
    }

    return {
        transactions: finished,
        accountsSeen,
        errors,
        warnings,
        dateRange,
        companyName,
        rowsRead,
    };
}

/* ------------------------------------------------------------------ */
/* Chart of Accounts parser                                             */
/* ------------------------------------------------------------------ */

/**
 * Map a QBO account Type to a GnuCash account_type.
 * Returns null for unrecognized types (caller defaults to ASSET + warning).
 */
export function mapQboTypeToGnucash(qboType: string): string | null {
    const t = normHeader(qboType);
    if (!t) return null;

    // Order matters: receivable/payable before generic asset/liability,
    // "other income"/"other expense" via the generic checks below.
    if (t.includes('accounts receivable') || /\ba\/?r\b/.test(t)) return 'RECEIVABLE';
    if (t.includes('accounts payable') || /\ba\/?p\b/.test(t)) return 'PAYABLE';
    if (t.includes('credit card')) return 'CREDIT';
    if (t === 'bank' || t.includes('bank')) return 'BANK';
    if (t.includes('fixed asset') || t.includes('other current asset') || t.includes('other asset'))
        return 'ASSET';
    if (
        t.includes('other current liabilit') ||
        t.includes('long term liabilit') ||
        t.includes('long-term liabilit') ||
        t === 'liability' ||
        t === 'liabilities'
    )
        return 'LIABILITY';
    if (t.includes('equity')) return 'EQUITY';
    if (t.includes('cost of goods sold') || t === 'cogs') return 'EXPENSE';
    if (t.includes('income') || t.includes('revenue')) return 'INCOME';
    if (t.includes('expense')) return 'EXPENSE';
    if (t === 'asset' || t === 'assets') return 'ASSET';
    return null;
}

interface CoaColumns {
    name: number;
    type: number;
    detail: number;
}

function detectCoaHeader(cells: string[]): CoaColumns | null {
    const norm = cells.map(normHeader);
    const find = (...names: string[]): number => {
        for (const n of names) {
            const idx = norm.findIndex((c) => c === n);
            if (idx >= 0) return idx;
        }
        return -1;
    };

    const name = find('full name', 'account name', 'name', 'account', 'account #');
    const type = find('type', 'account type');
    if (name < 0 || type < 0) return null;

    let detail = find('detail type', 'detail');
    if (detail < 0) detail = norm.findIndex((c) => c.includes('detail'));
    return { name, type, detail };
}

export function parseQboCoaCsv(content: string): QboCoaParseResult {
    const rows = splitCsvRows(content);
    const warnings: string[] = [];
    const errors: QboParseError[] = [];

    let headerIdx = -1;
    let cols: CoaColumns | null = null;
    for (let i = 0; i < Math.min(rows.length, MAX_HEADER_SCAN_ROWS); i++) {
        const detected = detectCoaHeader(rows[i]);
        if (detected) {
            headerIdx = i;
            cols = detected;
            break;
        }
    }
    if (headerIdx < 0 || !cols) {
        return {
            accounts: [],
            warnings,
            errors: [
                {
                    row: 1,
                    message:
                        'Could not find the Chart of Accounts header row (expected columns like Account name and Type). ' +
                        'The Chart of Accounts file was ignored.',
                },
            ],
        };
    }

    const cell = (row: string[], idx: number): string =>
        idx >= 0 && idx < row.length ? row[idx] : '';

    const accounts: QboCoaAccount[] = [];
    const seen = new Set<string>();
    for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const fullName = canonicalAccountPath(cell(row, cols.name));
        if (!fullName || /^total\b/i.test(fullName)) continue;
        const qboType = cell(row, cols.type);
        if (!qboType) continue;

        const key = fullName.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const gnucashType = mapQboTypeToGnucash(qboType);
        if (gnucashType === null) {
            warnings.push(
                `Unknown QuickBooks account type "${qboType}" for "${fullName}"; it will default to ASSET.`
            );
        }
        accounts.push({
            fullName,
            qboType,
            detailType: cell(row, cols.detail),
            gnucashType,
        });
    }

    if (accounts.length === 0) {
        errors.push({ row: headerIdx + 1, message: 'No accounts found in the Chart of Accounts file.' });
    }

    return { accounts, warnings, errors };
}

/* ------------------------------------------------------------------ */
/* Type inference + resolution                                          */
/* ------------------------------------------------------------------ */

/**
 * Keyword-based fallback when an account is missing from the CoA.
 * Order matters: specific keywords (receivable, payable, fee) win over
 * generic ones ("Bank Fees" is an EXPENSE, not a BANK account).
 */
export function inferAccountTypeFromName(path: string): string | null {
    const n = path.toLowerCase();
    if (/opening balance|retained earning|owner'?s? (equity|draw|contribution)|\bequity\b/.test(n)) return 'EQUITY';
    if (/receivable/.test(n)) return 'RECEIVABLE';
    if (/payable/.test(n)) return 'PAYABLE';
    if (/credit card|\bvisa\b|\bmastercard\b|\bamex\b/.test(n)) return 'CREDIT';
    if (/income|revenue|\bsales\b/.test(n)) return 'INCOME';
    if (/expense|cost of|\bcogs\b|\bfees?\b|\bcosts?\b|\bcharges?\b/.test(n)) return 'EXPENSE';
    if (/checking|savings|\bbank\b|\bcash\b/.test(n)) return 'BANK';
    if (/\bloan\b|liabilit|mortgage/.test(n)) return 'LIABILITY';
    return null;
}

const VALID_GNUCASH_TYPES = new Set([
    'BANK',
    'CASH',
    'ASSET',
    'RECEIVABLE',
    'PAYABLE',
    'CREDIT',
    'LIABILITY',
    'EQUITY',
    'INCOME',
    'EXPENSE',
    'STOCK',
    'MUTUAL',
    'TRADING',
]);

export function isValidGnucashType(type: string): boolean {
    return VALID_GNUCASH_TYPES.has(type);
}

/**
 * Resolve every journal account path to a GnuCash account type.
 *
 * Precedence: explicit override → CoA full-path match → CoA leaf-name match
 * (only when unambiguous) → keyword inference on the path → ASSET default.
 */
export function resolveAccountTypes(
    accountPaths: string[],
    coa: QboCoaParseResult | null,
    overrides: Record<string, string> = {}
): ResolvedAccount[] {
    const byFullName = new Map<string, QboCoaAccount>();
    const byLeaf = new Map<string, QboCoaAccount[]>();
    if (coa) {
        for (const a of coa.accounts) {
            const full = a.fullName.toLowerCase();
            if (!byFullName.has(full)) byFullName.set(full, a);
            const segments = a.fullName.split(':');
            const leaf = segments[segments.length - 1].trim().toLowerCase();
            const arr = byLeaf.get(leaf);
            if (arr) arr.push(a);
            else byLeaf.set(leaf, [a]);
        }
    }

    return accountPaths.map((path) => {
        const override = overrides[path];
        if (override && isValidGnucashType(override)) {
            return { path, gnucashType: override, source: 'override' as const };
        }

        const lower = path.toLowerCase();
        const coaMatch = byFullName.get(lower);
        if (coaMatch) {
            return {
                path,
                gnucashType: coaMatch.gnucashType ?? 'ASSET',
                source: 'coa' as const,
            };
        }
        const segments = path.split(':');
        const leaf = segments[segments.length - 1].trim().toLowerCase();
        const leafMatches = byLeaf.get(leaf) ?? [];
        if (leafMatches.length === 1) {
            return {
                path,
                gnucashType: leafMatches[0].gnucashType ?? 'ASSET',
                source: 'coa' as const,
            };
        }

        const inferred = inferAccountTypeFromName(path);
        if (inferred) return { path, gnucashType: inferred, source: 'inferred' as const };
        return { path, gnucashType: 'ASSET', source: 'default' as const };
    });
}
