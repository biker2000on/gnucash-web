/**
 * YNAB register export parser (pure — no database access).
 *
 * YNAB's "Export budget data" ZIP contains a register CSV with columns:
 *   Account, Flag, Date, Payee, Category Group/Category, Memo, Outflow, Inflow
 * (newer exports also carry separate "Category Group" and "Category"
 * columns — the combined column is preferred when present, otherwise the
 * two are joined as "Group: Category").
 *
 * Format assumptions:
 *   - Outflow and Inflow are separate unsigned columns, usually with a
 *     currency symbol ("$4.00"); amount = inflow − outflow.
 *   - Dates follow the budget's locale (MM/DD/YYYY or DD/MM/YYYY).
 *   - Payee becomes the description; Memo (and Flag, when set) go into the
 *     split memo. Transfer rows keep their "Transfer : Account" payee and,
 *     with no category, land in Uncategorized for the user to remap.
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

const YNAB_COLUMNS: ColumnSpec[] = [
    { key: 'account', names: ['account'], required: true },
    { key: 'flag', names: ['flag'] },
    { key: 'date', names: ['date'], required: true },
    { key: 'payee', names: ['payee'], required: true },
    { key: 'categoryCombined', names: ['category group/category'] },
    { key: 'categoryGroup', names: ['category group'] },
    { key: 'category', names: ['category'] },
    { key: 'memo', names: ['memo'] },
    { key: 'outflow', names: ['outflow'], required: true },
    { key: 'inflow', names: ['inflow'], required: true },
];

export function parseYnabCsv(
    content: string,
    locale: ImportLocale = DEFAULT_LOCALE
): PersonalParseResult {
    return parseYnabRows(splitCsvRows(content), locale);
}

export function parseYnabRows(
    rows: string[][],
    locale: ImportLocale = DEFAULT_LOCALE
): PersonalParseResult {
    const errors: PersonalParseError[] = [];
    const warnings: string[] = [];

    const header = detectHeaderRow(rows, YNAB_COLUMNS);
    if (!header) {
        return finalizeParseResult(
            [],
            [
                {
                    row: 1,
                    message:
                        'Could not find the YNAB register header row (expected columns like Account, Date, Payee, Category Group/Category, Outflow, Inflow). ' +
                        'Make sure this is the register CSV from YNAB’s "Export budget data".',
                },
            ],
            warnings,
            0,
            0
        );
    }
    const { headerIdx, cols } = header;

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

        const outflowRaw = cellAt(row, cols.outflow);
        const inflowRaw = cellAt(row, cols.inflow);
        const outflow = parseLocaleNumber(outflowRaw, { decimal: locale.decimal });
        const inflow = parseLocaleNumber(inflowRaw, { decimal: locale.decimal });
        if (outflow === null || inflow === null) {
            errors.push({
                row: rowNum,
                message: `Could not parse ${outflow === null ? `outflow "${outflowRaw}"` : `inflow "${inflowRaw}"`}.`,
            });
            continue;
        }
        const amount = Math.round((inflow - Math.abs(outflow)) * 100) / 100;

        // Combined "Group: Category" column preferred; else join the parts.
        let category = cellAt(row, cols.categoryCombined);
        if (!category) {
            const group = cellAt(row, cols.categoryGroup);
            const cat = cellAt(row, cols.category);
            category = group && cat ? `${group}: ${cat}` : cat || group;
        }

        const memoParts: string[] = [];
        const memo = cellAt(row, cols.memo);
        if (memo) memoParts.push(memo);
        const flag = cellAt(row, cols.flag);
        if (flag) memoParts.push(`Flag: ${flag}`);

        records.push({
            date,
            description: cellAt(row, cols.payee) || memo || 'YNAB import',
            memo: memoParts.join(' | '),
            amount,
            category,
            account: cellAt(row, cols.account),
            row: rowNum,
        });
    }

    return finalizeParseResult(records, errors, warnings, rowsRead, ambiguousDateRows);
}
