/**
 * Xero export parsers (pure — no database access).
 *
 * Two inputs:
 *
 * 1. Journal report CSV (Accounting → Reports → Journal Report → Export).
 *    Journal-style rows: Date, Source, Description, Reference, Journal
 *    Number (when exported), Account Code, Account, Debit, Credit (the
 *    Debit/Credit headers may carry a currency suffix, e.g. "Debit USD").
 *    Rows group into transactions by Journal Number when the column exists;
 *    otherwise a non-blank Date starts a new transaction and blank-date rows
 *    continue it (Xero prints the date once per journal).
 *
 * 2. Chart of Accounts CSV (Accounting → Chart of accounts → Export):
 *    Code, Name, Type, ... Xero type codes/labels map to GnuCash types via
 *    mapXeroTypeToGnucash() — see XERO_TYPE_MAP.
 *
 * Journal Account cells like "200 - Sales" have their leading numeric code
 * stripped so they match the Chart of Accounts by name.
 *
 * Sign convention: Debit → positive split value, Credit → negative (GnuCash;
 * a balanced transaction sums to zero). Output reuses the QuickBooks
 * structures (QboJournalParseResult / QboCoaParseResult) so type resolution
 * and the new-book commit machinery are shared, not forked.
 */

import {
    splitCsvRows,
    canonicalAccountPath,
    extractCompanyName,
    round2,
    MAX_HEADER_SCAN_ROWS,
    type QboCoaAccount,
    type QboCoaParseResult,
    type QboJournalParseResult,
    type QboJournalTransaction,
    type QboParseError,
} from './qbo-journal';
import {
    parseLocaleNumber,
    parseLocaleDate,
    DEFAULT_LOCALE,
    type ImportLocale,
} from './parse-locale';
import { detectHeaderRow, cellAt, type ColumnSpec } from './personal-import';

/* ------------------------------------------------------------------ */
/* Type mapping                                                         */
/* ------------------------------------------------------------------ */

/**
 * Xero account type → GnuCash account_type.
 *
 * Covers both the export CODES (BANK, CURRENT, CURRLIAB, ...) and the
 * human-readable LABELS some report exports use ("Current Asset", ...).
 */
export const XERO_TYPE_MAP: Record<string, string> = {
    // Assets
    bank: 'BANK',
    current: 'ASSET',
    'current asset': 'ASSET',
    inventory: 'ASSET',
    prepayment: 'ASSET',
    fixed: 'ASSET',
    'fixed asset': 'ASSET',
    noncurrent: 'ASSET',
    'non-current asset': 'ASSET',
    // Liabilities
    currliab: 'LIABILITY',
    'current liability': 'LIABILITY',
    liability: 'LIABILITY',
    termliab: 'LIABILITY',
    'non-current liability': 'LIABILITY',
    payg: 'LIABILITY',
    'payg liability': 'LIABILITY',
    // Equity
    equity: 'EQUITY',
    // Income
    revenue: 'INCOME',
    sales: 'INCOME',
    sale: 'INCOME',
    income: 'INCOME',
    otherincome: 'INCOME',
    'other income': 'INCOME',
    // Expenses
    expense: 'EXPENSE',
    expenses: 'EXPENSE',
    overheads: 'EXPENSE',
    overhead: 'EXPENSE',
    directcosts: 'EXPENSE',
    'direct costs': 'EXPENSE',
    depreciatn: 'EXPENSE',
    depreciation: 'EXPENSE',
    wagesexpense: 'EXPENSE',
    'wages expense': 'EXPENSE',
    superannuationexpense: 'EXPENSE',
    'superannuation expense': 'EXPENSE',
};

/**
 * Map a Xero type (code or label) to a GnuCash account_type; the account
 * NAME refines asset/liability types to RECEIVABLE/PAYABLE for Xero's
 * system accounts (Accounts Receivable is type CURRENT, Accounts Payable is
 * type CURRLIAB). Returns null for unrecognized types.
 */
export function mapXeroTypeToGnucash(xeroType: string, accountName: string = ''): string | null {
    const t = xeroType.trim().toLowerCase().replace(/\s+/g, ' ');
    const mapped = XERO_TYPE_MAP[t] ?? null;
    const n = accountName.toLowerCase();
    if (mapped === 'ASSET' || mapped === 'BANK') {
        if (n.includes('receivable') || /\bdebtors\b/.test(n)) return 'RECEIVABLE';
    }
    if (mapped === 'LIABILITY') {
        if (n.includes('payable') || /\bcreditors\b/.test(n)) return 'PAYABLE';
        if (n.includes('credit card')) return 'CREDIT';
    }
    return mapped;
}

/* ------------------------------------------------------------------ */
/* Chart of Accounts                                                    */
/* ------------------------------------------------------------------ */

const XERO_COA_COLUMNS: ColumnSpec[] = [
    { key: 'code', names: ['code', 'account code'] },
    { key: 'name', names: ['name', 'account name'], required: true },
    { key: 'type', names: ['type', 'account type'], required: true },
];

export function parseXeroCoaCsv(content: string): QboCoaParseResult {
    const rows = splitCsvRows(content);
    const warnings: string[] = [];
    const errors: QboParseError[] = [];

    const header = detectHeaderRow(rows, XERO_COA_COLUMNS);
    if (!header) {
        return {
            accounts: [],
            warnings,
            errors: [
                {
                    row: 1,
                    message:
                        'Could not find the Xero Chart of Accounts header row (expected columns like Code, Name, Type). ' +
                        'The Chart of Accounts file was ignored.',
                },
            ],
        };
    }
    const { headerIdx, cols } = header;

    const accounts: QboCoaAccount[] = [];
    const seen = new Set<string>();
    for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const fullName = canonicalAccountPath(cellAt(row, cols.name));
        if (!fullName || /^total\b/i.test(fullName)) continue;
        const xeroType = cellAt(row, cols.type);
        if (!xeroType) continue;

        const key = fullName.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const gnucashType = mapXeroTypeToGnucash(xeroType, fullName);
        if (gnucashType === null) {
            warnings.push(
                `Unknown Xero account type "${xeroType}" for "${fullName}"; it will default to ASSET.`
            );
        }
        accounts.push({
            fullName,
            qboType: xeroType,
            detailType: cellAt(row, cols.code),
            gnucashType,
        });
    }

    if (accounts.length === 0) {
        errors.push({ row: headerIdx + 1, message: 'No accounts found in the Chart of Accounts file.' });
    }
    return { accounts, warnings, errors };
}

/* ------------------------------------------------------------------ */
/* Journal report                                                       */
/* ------------------------------------------------------------------ */

/** Strip a leading numeric account code: "200 - Sales" → "Sales". */
export function stripXeroAccountCode(raw: string): string {
    const m = raw.trim().match(/^\d[\d.]*\s*[-–—:]\s*(.+)$/);
    return m ? m[1].trim() : raw.trim();
}

const XERO_JOURNAL_COLUMNS: ColumnSpec[] = [
    { key: 'date', names: ['date', 'journal date'], required: true },
    { key: 'source', names: ['source'] },
    { key: 'description', names: ['description', 'details', 'narration'] },
    { key: 'reference', names: ['reference'] },
    { key: 'journalNo', names: ['journal number', 'journalnumber', 'journal no', 'journal no.', 'journal'] },
    { key: 'account', names: ['account', 'account name'] },
    { key: 'accountCode', names: ['account code', 'accountcode'] },
    { key: 'debit', names: ['debit'], required: true },
    { key: 'credit', names: ['credit'], required: true },
];

export function parseXeroJournalCsv(
    content: string,
    locale: ImportLocale = DEFAULT_LOCALE
): QboJournalParseResult {
    const rows = splitCsvRows(content);
    const warnings: string[] = [];
    const errors: QboParseError[] = [];

    const header = detectHeaderRow(rows, XERO_JOURNAL_COLUMNS);
    if (!header || (header.cols.account < 0 && header.cols.accountCode < 0)) {
        return {
            transactions: [],
            accountsSeen: [],
            errors: [
                {
                    row: 1,
                    message:
                        'Could not find the Xero Journal header row (expected columns like Date, Account, Debit, Credit). ' +
                        'Make sure this is a Xero Journal report exported as CSV.',
                },
            ],
            warnings,
            dateRange: null,
            companyName: extractCompanyName(rows.slice(0, Math.min(rows.length, MAX_HEADER_SCAN_ROWS))),
            rowsRead: 0,
        };
    }
    const { headerIdx, cols } = header;
    const companyName = extractCompanyName(rows.slice(0, headerIdx));
    const hasJournalNo = cols.journalNo >= 0;

    interface XeroLine {
        /** Grouping key: 'jn:<journal number>' or 'row:<starting row>' */
        key: string;
        journalNo: string;
        date: string;
        source: string;
        description: string;
        reference: string;
        accountPath: string;
        amount: number;
        row: number;
    }

    // 1. Collect lines. Blank-date rows inherit the current journal context.
    const lines: XeroLine[] = [];
    const badKeys = new Set<string>();
    let rowsRead = 0;
    let current: { key: string; journalNo: string; date: string; source: string; description: string; reference: string } | null = null;

    for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 1;
        if (row.every((c) => c === '')) continue;
        rowsRead++;

        const dateRaw = cellAt(row, cols.date);
        const journalNo = hasJournalNo ? cellAt(row, cols.journalNo).trim() : '';

        if (dateRaw !== '') {
            const date = parseLocaleDate(dateRaw, { dayFirst: locale.dayFirst });
            if (!date) {
                errors.push({ row: rowNum, message: `Unrecognized date "${dateRaw}".` });
                current = null;
                continue;
            }
            // Journal-number grouping keeps continuation rows of the SAME
            // journal together even when every row repeats the date.
            const key = journalNo !== '' ? `jn:${journalNo}` : `row:${rowNum}`;
            if (!current || current.key !== key) {
                current = {
                    key,
                    journalNo,
                    date,
                    source: cellAt(row, cols.source),
                    description: cellAt(row, cols.description),
                    reference: cellAt(row, cols.reference),
                };
            }
        } else if (current) {
            if (journalNo !== '' && `jn:${journalNo}` !== current.key && hasJournalNo) {
                // A new journal number without a date — start a fresh group.
                current = {
                    key: `jn:${journalNo}`,
                    journalNo,
                    date: current.date,
                    source: cellAt(row, cols.source),
                    description: cellAt(row, cols.description),
                    reference: cellAt(row, cols.reference),
                };
            }
        } else {
            // Continuation row before any dated row: artifact
            continue;
        }

        const accountRaw = cols.account >= 0 ? cellAt(row, cols.account) : cellAt(row, cols.accountCode);
        if (accountRaw === '' || /^total\b/i.test(accountRaw)) continue;
        const accountPath = canonicalAccountPath(stripXeroAccountCode(accountRaw));
        if (accountPath === '') continue;

        const debit = parseLocaleNumber(cellAt(row, cols.debit), { decimal: locale.decimal });
        const credit = parseLocaleNumber(cellAt(row, cols.credit), { decimal: locale.decimal });
        if (debit === null || credit === null) {
            if (!badKeys.has(current.key)) {
                errors.push({
                    row: rowNum,
                    message: `Could not parse the debit/credit amount for account "${accountRaw}".`,
                });
            }
            badKeys.add(current.key);
            continue;
        }

        lines.push({
            key: current.key,
            journalNo: current.journalNo,
            date: current.date,
            source: current.source,
            description: current.description || cellAt(row, cols.description),
            reference: current.reference,
            accountPath,
            amount: round2(debit - credit),
            row: rowNum,
        });
    }

    // 2. Group by the key assigned while walking (journal number, else the
    //    dated row that opened the group) — insertion order preserved.
    const groupByKey = new Map<string, XeroLine[]>();
    const orderedGroups: XeroLine[][] = [];
    for (const l of lines) {
        const arr = groupByKey.get(l.key);
        if (arr) arr.push(l);
        else {
            const fresh = [l];
            groupByKey.set(l.key, fresh);
            orderedGroups.push(fresh);
        }
    }

    // 3. Validate balance and emit
    const transactions: QboJournalTransaction[] = [];
    for (const group of orderedGroups) {
        const first = group[0];
        if (badKeys.has(first.key)) continue;
        const sum = round2(group.reduce((s, l) => s + l.amount, 0));
        if (Math.abs(sum) > 0.01) {
            errors.push({
                row: first.row,
                message:
                    `Journal${first.journalNo ? ` ${first.journalNo}` : ''} on ${first.date}` +
                    `${first.description ? ` ("${first.description}")` : ''} does not balance: ` +
                    `debits and credits differ by ${sum.toFixed(2)}.`,
            });
            continue;
        }
        if (group.length < 2) continue; // lone zero row: artifact

        transactions.push({
            date: first.date,
            type: first.source,
            num: first.reference || first.journalNo,
            name: '',
            memo: first.description,
            lines: group.map((l) => ({
                accountPath: l.accountPath,
                amount: l.amount,
                memo: l.description !== first.description ? l.description : '',
                row: l.row,
            })),
            startRow: first.row,
        });
    }

    transactions.sort((a, b) =>
        a.date < b.date ? -1 : a.date > b.date ? 1 : a.startRow - b.startRow
    );

    // 4. Aggregate
    const accountsSeen = Array.from(
        new Set(transactions.flatMap((t) => t.lines.map((l) => l.accountPath)))
    ).sort((a, b) => a.localeCompare(b));

    let dateRange: QboJournalParseResult['dateRange'] = null;
    if (transactions.length > 0) {
        dateRange = {
            start: transactions[0].date,
            end: transactions[transactions.length - 1].date,
        };
    }

    return {
        transactions,
        accountsSeen,
        errors,
        warnings,
        dateRange,
        companyName,
        rowsRead,
    };
}
