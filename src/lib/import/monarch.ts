/**
 * Monarch Money transaction export parser (pure — no database access).
 *
 * Monarch's "Download transactions" CSV columns:
 *   Date, Merchant, Category, Account, Original Statement, Notes, Amount, Tags
 *
 * Format assumptions:
 *   - Amount is SIGNED: negative = money out (expense), positive = money in
 *     (income/refund) — used as-is.
 *   - Dates are ISO YYYY-MM-DD in current exports; numeric MM/DD/YYYY
 *     (or DD/MM/YYYY under the EU locale) is tolerated.
 *   - Merchant becomes the description; Original Statement (when it differs),
 *     Notes, and Tags are preserved in the split memo.
 */

import { splitCsvRows } from './qbo-journal';
import {
    parseLocaleNumber,
    parseLocaleDate,
    DEFAULT_LOCALE,
    type ImportLocale,
} from './parse-locale';
import {
    detectHeaderRow,
    cellAt,
    finalizeParseResult,
    isAmbiguousDate,
    type ColumnSpec,
    type PersonalParseError,
    type PersonalParseResult,
    type PersonalRecord,
} from './personal-import';

const MONARCH_COLUMNS: ColumnSpec[] = [
    { key: 'date', names: ['date'], required: true },
    { key: 'merchant', names: ['merchant', 'description'], required: true },
    { key: 'category', names: ['category'] },
    { key: 'account', names: ['account', 'account name'], required: true },
    { key: 'originalStatement', names: ['original statement'] },
    { key: 'notes', names: ['notes'] },
    { key: 'amount', names: ['amount'], required: true },
    { key: 'tags', names: ['tags'] },
];

export function parseMonarchCsv(
    content: string,
    locale: ImportLocale = DEFAULT_LOCALE
): PersonalParseResult {
    return parseMonarchRows(splitCsvRows(content), locale);
}

export function parseMonarchRows(
    rows: string[][],
    locale: ImportLocale = DEFAULT_LOCALE
): PersonalParseResult {
    const errors: PersonalParseError[] = [];
    const warnings: string[] = [];

    const header = detectHeaderRow(rows, MONARCH_COLUMNS);
    if (!header) {
        return finalizeParseResult(
            [],
            [
                {
                    row: 1,
                    message:
                        'Could not find the Monarch Money header row (expected columns like Date, Merchant, Category, Account, Amount). ' +
                        'Make sure this is a Monarch Money transactions CSV export.',
                },
            ],
            warnings,
            0,
            0
        );
    }
    const { headerIdx, cols } = header;
    if (cols.category < 0) warnings.push('No Category column found; all rows import as Uncategorized.');

    const records: PersonalRecord[] = [];
    let rowsRead = 0;
    let ambiguousDateRows = 0;

    for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 1;
        if (row.every((c) => c === '')) continue;
        rowsRead++;

        const dateRaw = cellAt(row, cols.date);
        const date = parseLocaleDate(dateRaw, { dayFirst: locale.dayFirst });
        if (!date) {
            errors.push({ row: rowNum, message: `Unrecognized date "${dateRaw}".` });
            continue;
        }
        if (isAmbiguousDate(dateRaw)) ambiguousDateRows++;

        const amountRaw = cellAt(row, cols.amount);
        const amount = parseLocaleNumber(amountRaw, { decimal: locale.decimal });
        if (amount === null) {
            errors.push({ row: rowNum, message: `Could not parse amount "${amountRaw}".` });
            continue;
        }

        const merchant = cellAt(row, cols.merchant);
        const original = cellAt(row, cols.originalStatement);
        const memoParts: string[] = [];
        if (original && original !== merchant) memoParts.push(original);
        const notes = cellAt(row, cols.notes);
        if (notes) memoParts.push(notes);
        const tags = cellAt(row, cols.tags);
        if (tags) memoParts.push(`Tags: ${tags}`);

        records.push({
            date,
            description: merchant || original || 'Monarch import',
            memo: memoParts.join(' | '),
            amount, // Monarch amounts are already signed (negative = expense)
            category: cellAt(row, cols.category),
            account: cellAt(row, cols.account),
            row: rowNum,
        });
    }

    return finalizeParseResult(records, errors, warnings, rowsRead, ambiguousDateRows);
}
