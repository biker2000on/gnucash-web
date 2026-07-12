/**
 * QIF (Quicken Interchange Format) Parser
 *
 * Pure parser — no database access. Converts QIF text into a structured
 * result of accounts, transactions, and categories.
 *
 * Supported sections:
 *   !Type:Bank, !Type:Cash, !Type:CCard, !Type:Oth A, !Type:Oth L  — transaction lists
 *   !Account                                                        — account headers (multi-account files)
 *   !Type:Cat                                                       — category lists
 *   !Option:AutoSwitch / !Clear:AutoSwitch                          — tolerated (ignored)
 * Unsupported sections (!Type:Invst, !Type:Memorized, !Type:Class, ...)
 * are skipped with a warning.
 *
 * Tolerant of BOM, CRLF/LF/CR line endings, and trailing whitespace.
 */

export type QifDateFormat = 'auto' | 'us' | 'eu';

export interface QifSplitRecord {
    /** Plain category path ("Food:Dining"), null when the split is a transfer or uncategorized */
    category: string | null;
    /** Transfer target account name (contents of [brackets]), null otherwise */
    transfer: string | null;
    memo: string;
    /** Signed amount, same sign convention as the transaction total */
    amount: number;
}

export interface QifTransactionRecord {
    /** ISO date YYYY-MM-DD */
    date: string;
    /** Signed amount as it affects the source account (negative = money out) */
    amount: number;
    payee: string;
    memo: string;
    /** Check number / reference (N field) */
    num: string;
    /** 'n' = not cleared, 'c' = cleared (*, c), 'y' = reconciled (X, R) */
    cleared: 'n' | 'c' | 'y';
    /** Category path ("Food:Dining"), null when transfer or uncategorized */
    category: string | null;
    /** Transfer target account name ([Account] syntax), null otherwise */
    transfer: string | null;
    splits: QifSplitRecord[];
}

export interface QifAccountRecord {
    /** Account name from an !Account block; '' when the file had no account header */
    name: string;
    /** QIF type: 'Bank' | 'Cash' | 'CCard' | 'Oth A' | 'Oth L' | ... */
    type: string;
    description: string;
    transactions: QifTransactionRecord[];
}

export interface QifCategoryRecord {
    /** Category path, colon-separated */
    name: string;
    description: string;
    isIncome: boolean;
}

export interface QifParseResult {
    accounts: QifAccountRecord[];
    categories: QifCategoryRecord[];
    warnings: string[];
}

export interface QifParseOptions {
    /** How to interpret ambiguous dates. 'us' = MM/DD, 'eu' = DD/MM, 'auto' = detect (default) */
    dateFormat?: QifDateFormat;
}

/* ------------------------------------------------------------------ */
/* Internal raw structures (dates unresolved until end of parse)       */
/* ------------------------------------------------------------------ */

interface RawSplit {
    categoryRaw: string;
    memo: string;
    amount: number | null;
}

interface RawTxn {
    rawDate: string;
    amount: number | null;
    payee: string;
    memo: string;
    num: string;
    cleared: 'n' | 'c' | 'y';
    category: string | null;
    transfer: string | null;
    splits: RawSplit[];
    lineNo: number;
}

const BANK_LIKE_TYPES = new Set(['bank', 'cash', 'ccard', 'oth a', 'oth l']);

/** Parse a QIF amount: comma thousands, leading minus, optional parentheses. */
export function parseQifAmount(raw: string): number | null {
    let s = raw.trim();
    if (!s) return null;
    let negative = false;
    if (s.startsWith('(') && s.endsWith(')')) {
        negative = true;
        s = s.slice(1, -1);
    }
    s = s.replace(/,/g, '').replace(/\s/g, '');
    if (s.startsWith('-')) {
        negative = !negative ? true : negative;
        s = s.slice(1);
        negative = true;
    } else if (s.startsWith('+')) {
        s = s.slice(1);
    }
    if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
    const value = parseFloat(s);
    if (Number.isNaN(value)) return null;
    return negative ? -value : value;
}

/** Map a QIF cleared-status character to a reconcile bucket. */
function parseCleared(raw: string): 'n' | 'c' | 'y' {
    const c = raw.trim();
    if (c === '*' || c.toLowerCase() === 'c') return 'c';
    if (c.toLowerCase() === 'x' || c.toLowerCase() === 'r') return 'y';
    return 'n';
}

/**
 * Parse an L (or S) field into category vs [transfer].
 * Strips a "/Class" suffix if present.
 */
function parseCategoryField(raw: string): { category: string | null; transfer: string | null } {
    let s = raw.trim();
    if (!s) return { category: null, transfer: null };
    // Strip class suffix ("Category/Class" or "[Acct]/Class")
    const slashIdx = s.indexOf('/');
    if (slashIdx >= 0) s = s.slice(0, slashIdx).trim();
    if (!s) return { category: null, transfer: null };
    if (s.startsWith('[') && s.endsWith(']')) {
        const inner = s.slice(1, -1).trim();
        return { category: null, transfer: inner || null };
    }
    return { category: s, transfer: null };
}

interface DateParts {
    p0: number;
    p1: number;
    year: number;
    valid: boolean;
}

/**
 * Split a raw QIF date into its three components.
 * Handles MM/DD/YY, MM/DD/YYYY, MM/DD'YY (Quicken 2000+ apostrophe),
 * MM/DD' 5, dashes and dots as separators, and DD/MM orders.
 * Year is always the last component.
 */
function splitDateParts(raw: string): DateParts {
    const s = raw.trim();
    const hasApostrophe = s.includes("'");
    const normalized = s.replace(/'/g, '/');
    const parts = normalized
        .split(/[/\-.]/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
    if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) {
        return { p0: 0, p1: 0, year: 0, valid: false };
    }
    const p0 = parseInt(parts[0], 10);
    const p1 = parseInt(parts[1], 10);
    const rawYear = parts[2];
    let year: number;
    if (rawYear.length >= 3) {
        year = parseInt(rawYear, 10);
    } else {
        const yy = parseInt(rawYear, 10);
        if (hasApostrophe) {
            // Quicken uses the apostrophe to mark years 2000+
            year = 2000 + yy;
        } else {
            year = yy >= 70 ? 1900 + yy : 2000 + yy;
        }
    }
    return { p0, p1, year, valid: true };
}

/** Decide the date component order for the whole file. */
function resolveDateOrder(
    dateFormat: QifDateFormat,
    allDates: DateParts[],
    warnings: string[]
): 'mdy' | 'dmy' {
    if (dateFormat === 'us') return 'mdy';
    if (dateFormat === 'eu') return 'dmy';
    let dmyVotes = 0;
    let mdyVotes = 0;
    for (const d of allDates) {
        if (!d.valid) continue;
        if (d.p0 > 12 && d.p1 <= 12) dmyVotes++;
        else if (d.p1 > 12 && d.p0 <= 12) mdyVotes++;
    }
    if (dmyVotes > 0 && mdyVotes > 0) {
        warnings.push(
            `Conflicting date orders detected (${mdyVotes} MM/DD vs ${dmyVotes} DD/MM votes); using the majority. Set an explicit date format if results look wrong.`
        );
        return dmyVotes > mdyVotes ? 'dmy' : 'mdy';
    }
    if (dmyVotes > 0) return 'dmy';
    if (mdyVotes > 0) return 'mdy';
    if (allDates.some((d) => d.valid)) {
        // Every date is ambiguous (both components <= 12); assume US.
        warnings.push('Date order is ambiguous in this file; assuming MM/DD (US). Choose a date format explicitly if this is wrong.');
    }
    return 'mdy';
}

/** Convert date parts + order to an ISO date, or null if invalid. */
function toIsoDate(parts: DateParts, order: 'mdy' | 'dmy'): string | null {
    if (!parts.valid) return null;
    const month = order === 'mdy' ? parts.p0 : parts.p1;
    const day = order === 'mdy' ? parts.p1 : parts.p0;
    if (month < 1 || month > 12 || day < 1 || day > 31 || parts.year < 1000) return null;
    // Validate day against actual month length
    const daysInMonth = new Date(Date.UTC(parts.year, month, 0)).getUTCDate();
    if (day > daysInMonth) return null;
    return `${parts.year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
        .toString()
        .padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Main parser                                                          */
/* ------------------------------------------------------------------ */

export function parseQif(content: string, options: QifParseOptions = {}): QifParseResult {
    const dateFormat = options.dateFormat ?? 'auto';
    const warnings: string[] = [];
    const categories: QifCategoryRecord[] = [];

    // Accounts keyed by name; preserves insertion order.
    const accountMap = new Map<string, QifAccountRecord & { rawTxns: RawTxn[] }>();
    const skippedSections = new Set<string>();

    function getOrCreateAccount(name: string, type: string, description = '') {
        const key = name.trim();
        let account = accountMap.get(key);
        if (!account) {
            account = { name: key, type, description, transactions: [], rawTxns: [] };
            accountMap.set(key, account);
        } else {
            if (type && !account.type) account.type = type;
            if (description && !account.description) account.description = description;
        }
        return account;
    }

    // Strip BOM, normalize line endings
    const text = content.replace(/^﻿/, '');
    const lines = text.split(/\r\n|\n|\r/);

    type Mode = 'none' | 'txn' | 'account' | 'category' | 'skip';
    let mode: Mode = 'none';
    let currentType = 'Bank';
    // The account the next transactions belong to (set by !Account blocks)
    let currentAccount: (QifAccountRecord & { rawTxns: RawTxn[] }) | null = null;

    // In-progress records
    let txn: RawTxn | null = null;
    let acctRec: { name: string; type: string; description: string } | null = null;
    let catRec: { name: string; description: string; isIncome: boolean } | null = null;

    let unknownCodeWarnings = 0;
    const MAX_UNKNOWN_WARNINGS = 10;

    function flushTxn(lineNo: number) {
        if (!txn) return;
        const target = currentAccount ?? getOrCreateAccount('', currentType);
        if (!txn.rawDate) {
            warnings.push(`Transaction near line ${lineNo} has no date; skipped.`);
        } else {
            target.rawTxns.push(txn);
        }
        txn = null;
    }

    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const line = rawLine.replace(/\s+$/, ''); // trailing whitespace tolerance
        if (!line) continue;

        // Section headers
        if (line.startsWith('!')) {
            // A header implicitly terminates any in-progress record
            if (txn) flushTxn(i + 1);
            acctRec = null;
            catRec = null;

            const header = line.slice(1).trim();
            const lower = header.toLowerCase();

            if (lower.startsWith('type:')) {
                const typeName = header.slice(5).trim();
                if (BANK_LIKE_TYPES.has(typeName.toLowerCase())) {
                    mode = 'txn';
                    currentType = typeName;
                    // If an !Account block preceded, transactions attach to it;
                    // record the section type on the account if it has none.
                    if (currentAccount && !currentAccount.type) currentAccount.type = typeName;
                } else if (typeName.toLowerCase() === 'cat') {
                    mode = 'category';
                } else {
                    mode = 'skip';
                    if (!skippedSections.has(typeName.toLowerCase())) {
                        skippedSections.add(typeName.toLowerCase());
                        warnings.push(`Section "!Type:${typeName}" is not supported and was skipped.`);
                    }
                }
            } else if (lower === 'account') {
                mode = 'account';
            } else if (lower.startsWith('option:') || lower.startsWith('clear:')) {
                // AutoSwitch markers — ignore, keep current mode
            } else {
                mode = 'skip';
                if (!skippedSections.has(lower)) {
                    skippedSections.add(lower);
                    warnings.push(`Section "!${header}" is not supported and was skipped.`);
                }
            }
            continue;
        }

        const code = line[0];
        const value = line.slice(1);

        switch (mode) {
            case 'txn': {
                if (!txn) {
                    txn = {
                        rawDate: '',
                        amount: null,
                        payee: '',
                        memo: '',
                        num: '',
                        cleared: 'n',
                        category: null,
                        transfer: null,
                        splits: [],
                        lineNo: i + 1,
                    };
                }
                switch (code) {
                    case 'D':
                        txn.rawDate = value.trim();
                        break;
                    case 'T':
                    case 'U': {
                        const amt = parseQifAmount(value);
                        if (amt === null) {
                            warnings.push(`Unparseable amount "${value.trim()}" at line ${i + 1}.`);
                        } else if (code === 'T' || txn.amount === null) {
                            // T takes precedence over U when both are present
                            txn.amount = amt;
                        }
                        break;
                    }
                    case 'P':
                        txn.payee = value.trim();
                        break;
                    case 'M':
                        txn.memo = value.trim();
                        break;
                    case 'N':
                        txn.num = value.trim();
                        break;
                    case 'C':
                        txn.cleared = parseCleared(value);
                        break;
                    case 'L': {
                        const parsed = parseCategoryField(value);
                        txn.category = parsed.category;
                        txn.transfer = parsed.transfer;
                        break;
                    }
                    case 'S':
                        txn.splits.push({ categoryRaw: value.trim(), memo: '', amount: null });
                        break;
                    case 'E':
                        if (txn.splits.length > 0) {
                            txn.splits[txn.splits.length - 1].memo = value.trim();
                        }
                        break;
                    case '$': {
                        if (txn.splits.length > 0) {
                            const amt = parseQifAmount(value);
                            if (amt === null) {
                                warnings.push(`Unparseable split amount "${value.trim()}" at line ${i + 1}.`);
                            } else {
                                txn.splits[txn.splits.length - 1].amount = amt;
                            }
                        }
                        break;
                    }
                    case 'A':
                    case '%':
                        // Address / percentage lines — ignored
                        break;
                    case '^':
                        flushTxn(i + 1);
                        break;
                    default:
                        if (unknownCodeWarnings < MAX_UNKNOWN_WARNINGS) {
                            warnings.push(`Unknown field code "${code}" at line ${i + 1}; ignored.`);
                            unknownCodeWarnings++;
                        }
                        break;
                }
                break;
            }

            case 'account': {
                if (!acctRec) acctRec = { name: '', type: '', description: '' };
                switch (code) {
                    case 'N':
                        acctRec.name = value.trim();
                        break;
                    case 'T':
                        acctRec.type = value.trim();
                        break;
                    case 'D':
                        acctRec.description = value.trim();
                        break;
                    case '^':
                        if (acctRec.name) {
                            currentAccount = getOrCreateAccount(acctRec.name, acctRec.type, acctRec.description);
                        }
                        acctRec = null;
                        break;
                    default:
                        // L (credit limit), B (balance), X extensions — ignore
                        break;
                }
                break;
            }

            case 'category': {
                if (!catRec) catRec = { name: '', description: '', isIncome: false };
                switch (code) {
                    case 'N':
                        catRec.name = value.trim();
                        break;
                    case 'D':
                        catRec.description = value.trim();
                        break;
                    case 'I':
                        catRec.isIncome = true;
                        break;
                    case 'E':
                        catRec.isIncome = false;
                        break;
                    case '^':
                        if (catRec.name) {
                            categories.push({ ...catRec });
                        }
                        catRec = null;
                        break;
                    default:
                        // T (tax related), R (tax schedule), B (budget) — ignore
                        break;
                }
                break;
            }

            case 'skip':
            case 'none':
                // Ignore body lines of unsupported / undeclared sections
                break;
        }
    }
    // Flush a final unterminated transaction (missing trailing ^)
    if (txn) flushTxn(lines.length);

    /* --------- Resolve dates (needs whole-file context for 'auto') --------- */
    const allParts: DateParts[] = [];
    for (const account of accountMap.values()) {
        for (const t of account.rawTxns) allParts.push(splitDateParts(t.rawDate));
    }
    const order = resolveDateOrder(dateFormat, allParts, warnings);

    const accounts: QifAccountRecord[] = [];
    for (const account of accountMap.values()) {
        const transactions: QifTransactionRecord[] = [];
        for (const t of account.rawTxns) {
            const iso = toIsoDate(splitDateParts(t.rawDate), order);
            if (!iso) {
                warnings.push(`Invalid date "${t.rawDate}" near line ${t.lineNo}; transaction skipped.`);
                continue;
            }
            // Resolve amount: fall back to split sum when T is absent
            const splits: QifSplitRecord[] = t.splits.map((s) => {
                const parsed = parseCategoryField(s.categoryRaw);
                return {
                    category: parsed.category,
                    transfer: parsed.transfer,
                    memo: s.memo,
                    amount: s.amount ?? 0,
                };
            });
            let amount = t.amount;
            if (amount === null) {
                if (splits.length > 0) {
                    amount = splits.reduce((sum, s) => sum + s.amount, 0);
                } else {
                    warnings.push(`Transaction "${t.payee || t.rawDate}" near line ${t.lineNo} has no amount; assuming 0.`);
                    amount = 0;
                }
            }
            if (splits.length > 0) {
                const splitSum = splits.reduce((sum, s) => sum + s.amount, 0);
                if (Math.abs(splitSum - amount) > 0.005) {
                    warnings.push(
                        `Splits for "${t.payee || iso}" (${iso}) sum to ${splitSum.toFixed(2)} but the transaction total is ${amount.toFixed(2)}.`
                    );
                }
            }
            transactions.push({
                date: iso,
                amount: Math.round(amount * 100) / 100,
                payee: t.payee,
                memo: t.memo,
                num: t.num,
                cleared: t.cleared,
                category: t.category,
                transfer: t.transfer,
                splits,
            });
        }
        accounts.push({
            name: account.name,
            type: account.type || 'Bank',
            description: account.description,
            transactions,
        });
    }

    return { accounts, categories, warnings };
}
