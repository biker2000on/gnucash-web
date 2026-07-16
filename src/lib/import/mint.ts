/**
 * Mint transaction export parser (pure — no database access).
 *
 * Mint's "Export all transactions" CSV columns:
 *   Date, Description, Original Description, Amount, Transaction Type,
 *   Category, Account Name, Labels, Notes
 *
 * Format assumptions:
 *   - Amount is ALWAYS positive; "Transaction Type" carries the sign:
 *     debit = money out (negative), credit = money in (positive). A signed
 *     amount cell is tolerated (its absolute value is used).
 *   - Dates are MM/DD/YYYY (locale-dependent; some Mint eras exported
 *     "Jan 05, 2025" — month-name forms are accepted too).
 *   - Description is the cleaned payee; Original Description, Labels, and
 *     Notes are preserved in the split memo.
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

const MINT_COLUMNS: ColumnSpec[] = [
    { key: 'date', names: ['date'], required: true },
    { key: 'description', names: ['description'], required: true },
    { key: 'originalDescription', names: ['original description'] },
    { key: 'amount', names: ['amount'], required: true },
    { key: 'type', names: ['transaction type', 'type'], required: true },
    { key: 'category', names: ['category'] },
    { key: 'account', names: ['account name', 'account'] },
    { key: 'labels', names: ['labels'] },
    { key: 'notes', names: ['notes'] },
];

export function parseMintCsv(
    content: string,
    locale: ImportLocale = DEFAULT_LOCALE
): PersonalParseResult {
    return parseMintRows(splitCsvRows(content), locale);
}

export function parseMintRows(
    rows: string[][],
    locale: ImportLocale = DEFAULT_LOCALE
): PersonalParseResult {
    const errors: PersonalParseError[] = [];
    const warnings: string[] = [];

    const header = detectHeaderRow(rows, MINT_COLUMNS);
    if (!header) {
        return finalizeParseResult(
            [],
            [
                {
                    row: 1,
                    message:
                        'Could not find the Mint header row (expected columns like Date, Description, Amount, Transaction Type, Category, Account Name). ' +
                        'Make sure this is a Mint transactions CSV export.',
                },
            ],
            warnings,
            0,
            0
        );
    }
    const { headerIdx, cols } = header;
    if (cols.category < 0) warnings.push('No Category column found; all rows import as Uncategorized.');
    if (cols.account < 0) warnings.push('No Account Name column found; all rows import into a single account.');

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
        const parsed = parseLocaleNumber(amountRaw, { decimal: locale.decimal });
        if (parsed === null) {
            errors.push({ row: rowNum, message: `Could not parse amount "${amountRaw}".` });
            continue;
        }

        // Mint amounts are unsigned; Transaction Type supplies the sign.
        const type = cellAt(row, cols.type).trim().toLowerCase();
        let amount: number;
        if (type === 'debit') amount = -Math.abs(parsed);
        else if (type === 'credit') amount = Math.abs(parsed);
        else if (type === '') amount = parsed; // tolerate signed exports with no type
        else {
            errors.push({ row: rowNum, message: `Unknown transaction type "${cellAt(row, cols.type)}" (expected debit or credit).` });
            continue;
        }

        const description = cellAt(row, cols.description) || cellAt(row, cols.originalDescription) || 'Mint import';
        const memoParts: string[] = [];
        const original = cellAt(row, cols.originalDescription);
        if (original && original !== cellAt(row, cols.description)) memoParts.push(original);
        const notes = cellAt(row, cols.notes);
        if (notes) memoParts.push(notes);
        const labels = cellAt(row, cols.labels);
        if (labels) memoParts.push(`Labels: ${labels}`);

        records.push({
            date,
            description,
            memo: memoParts.join(' | '),
            amount,
            category: cellAt(row, cols.category),
            account: cellAt(row, cols.account),
            row: rowNum,
        });
    }

    return finalizeParseResult(records, errors, warnings, rowsRead, ambiguousDateRows);
}
