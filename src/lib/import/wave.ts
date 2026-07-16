/**
 * Wave Accounting export parsers (pure — no database access).
 *
 * Two inputs:
 *
 * 1. "Accounting Transactions (CSV)" export. One row per transaction LINE:
 *    Transaction ID (newer exports), Transaction Date, Account Name,
 *    Transaction Description, Transaction Line Description, and amounts in
 *    one of three tolerated shapes:
 *      - "Debit Amount (Two Column Approach)" / "Credit Amount (...)" pair
 *      - a signed "Amount (One column)" (debit positive, credit negative)
 *      - an unsigned Amount plus a debit/credit indicator column
 *        ("Debit Or Credit" with values debit/credit)
 *    Rows group into balanced transactions by Transaction ID when the column
 *    exists; otherwise consecutive rows sharing (date + transaction
 *    description) form a group, validated to sum to zero like the QBO
 *    General Ledger reconstructor.
 *
 * 2. Optional Chart of Accounts CSV (Account Name, Account Type). Wave types
 *    ("Cash and Bank", "Expected Payments from Customers", ...) map to
 *    GnuCash types via mapWaveTypeToGnucash() — see the table there.
 *
 * Output shape reuses the QuickBooks structures (QboJournalParseResult /
 * QboCoaParseResult) so the type-resolution and new-book commit machinery is
 * shared, not forked.
 */

import {
    splitCsvRows,
    canonicalAccountPath,
    round2,
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
/* Chart of Accounts                                                    */
/* ------------------------------------------------------------------ */

/**
 * Map a Wave account type to a GnuCash account_type. Returns null for
 * unrecognized types (caller defaults to ASSET + warning).
 *
 * Wave type → GnuCash type:
 *   Cash and Bank                              → BANK
 *   Expected Payments from Customers           → RECEIVABLE
 *   Expected Payments to Vendors               → PAYABLE
 *   Credit Card                                → CREDIT
 *   Money in Transit / Inventory / Property, Plant, Equipment /
 *     Depreciation and Amortization / Vendor Prepayments and Vendor Credits /
 *     Other Short-Term Asset / Other Long-Term Asset  → ASSET
 *   Loan and Line of Credit / Sales Taxes / Due For Payroll /
 *     Due to You and Other Business Owners / Customer Prepayments and
 *     Customer Credits / Other Short-Term Liability / Other Long-Term
 *     Liability                                → LIABILITY
 *   Business Owner Contribution and Drawing / Retained Earnings / Equity
 *                                              → EQUITY
 *   Income / Discount / Other Income / Uncategorized Income /
 *     Gain On Foreign Exchange                 → INCOME
 *   Operating Expense / Cost of Goods Sold / Payment Processing Fee /
 *     Payroll Expense / Uncategorized Expense / Loss On Foreign Exchange
 *                                              → EXPENSE
 */
export function mapWaveTypeToGnucash(waveType: string): string | null {
    const t = waveType.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!t) return null;

    // Specific matches first — several Wave labels contain generic words.
    if (t.includes('expected payments from customers') || t.includes('receivable')) return 'RECEIVABLE';
    if (t.includes('expected payments to vendors') || t.includes('payable')) return 'PAYABLE';
    if (t.includes('credit card')) return 'CREDIT';
    if (t.includes('cash and bank') || t === 'bank') return 'BANK';
    if (
        t.includes('due to you') ||
        t.includes('due for payroll') ||
        t.includes('sales tax') ||
        t.includes('customer prepayment') ||
        t.includes('loan') ||
        t.includes('line of credit') ||
        t.includes('liabilit')
    )
        return 'LIABILITY';
    if (t.includes('owner') || t.includes('retained earning') || t.includes('equity')) return 'EQUITY';
    if (t.includes('income') || t === 'discount' || t.includes('gain on foreign')) return 'INCOME';
    if (
        t.includes('expense') ||
        t.includes('cost of goods') ||
        t.includes('payment processing fee') ||
        t.includes('loss on foreign')
    )
        return 'EXPENSE';
    if (
        t.includes('asset') ||
        t.includes('money in transit') ||
        t.includes('inventory') ||
        t.includes('property') ||
        t.includes('depreciation') ||
        t.includes('vendor prepayment')
    )
        return 'ASSET';
    return null;
}

const WAVE_COA_COLUMNS: ColumnSpec[] = [
    { key: 'name', names: ['account name', 'name', 'account'], required: true },
    { key: 'type', names: ['account type', 'type'], required: true },
    { key: 'description', names: ['description'] },
];

export function parseWaveCoaCsv(content: string): QboCoaParseResult {
    const rows = splitCsvRows(content);
    const warnings: string[] = [];
    const errors: QboParseError[] = [];

    const header = detectHeaderRow(rows, WAVE_COA_COLUMNS);
    if (!header) {
        return {
            accounts: [],
            warnings,
            errors: [
                {
                    row: 1,
                    message:
                        'Could not find the Wave Chart of Accounts header row (expected columns like Account Name and Account Type). ' +
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
        const waveType = cellAt(row, cols.type);
        if (!waveType) continue;

        const key = fullName.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const gnucashType = mapWaveTypeToGnucash(waveType);
        if (gnucashType === null) {
            warnings.push(
                `Unknown Wave account type "${waveType}" for "${fullName}"; it will default to ASSET.`
            );
        }
        accounts.push({ fullName, qboType: waveType, detailType: '', gnucashType });
    }

    if (accounts.length === 0) {
        errors.push({ row: headerIdx + 1, message: 'No accounts found in the Chart of Accounts file.' });
    }
    return { accounts, warnings, errors };
}

/* ------------------------------------------------------------------ */
/* Accounting Transactions                                              */
/* ------------------------------------------------------------------ */

const WAVE_TXN_COLUMNS: ColumnSpec[] = [
    { key: 'id', names: ['transaction id'] },
    { key: 'date', names: ['transaction date', 'date'], required: true },
    { key: 'account', names: ['account name', 'account'], required: true },
    { key: 'description', names: ['transaction description'] },
    { key: 'lineDescription', names: ['transaction line description', 'line description'] },
    { key: 'amount', names: ['amount (one column)', 'amount'] },
    { key: 'debit', names: ['debit amount (two column approach)', 'debit amount', 'debit'] },
    { key: 'credit', names: ['credit amount (two column approach)', 'credit amount', 'credit'] },
    { key: 'indicator', names: ['debit or credit', 'debit/credit', 'entry type'] },
];

export function parseWaveTransactionsCsv(
    content: string,
    locale: ImportLocale = DEFAULT_LOCALE
): QboJournalParseResult {
    const rows = splitCsvRows(content);
    const warnings: string[] = [];
    const errors: QboParseError[] = [];

    const header = detectHeaderRow(rows, WAVE_TXN_COLUMNS);
    if (!header || (header.cols.amount < 0 && header.cols.debit < 0)) {
        return {
            transactions: [],
            accountsSeen: [],
            errors: [
                {
                    row: 1,
                    message:
                        'Could not find the Wave transactions header row (expected columns like Transaction Date, Account Name, and Amount or Debit/Credit Amount). ' +
                        'Make sure this is the Wave "Accounting Transactions (CSV)" export.',
                },
            ],
            warnings,
            dateRange: null,
            companyName: null,
            rowsRead: 0,
        };
    }
    const { headerIdx, cols } = header;
    const hasId = cols.id >= 0;

    // Tolerant substring header matching can bind debit/credit to the SAME
    // column (e.g. an indicator column named "Debit Or Credit") or amount to
    // "Debit Amount (...)". Only trust distinct, non-overlapping columns.
    if (cols.debit === cols.credit || cols.debit === cols.indicator || cols.credit === cols.indicator) {
        cols.debit = -1;
        cols.credit = -1;
    }
    if (cols.amount === cols.debit || cols.amount === cols.credit || cols.amount === cols.indicator) {
        cols.amount = -1;
    }
    const twoColumn = cols.debit >= 0 && cols.credit >= 0;

    interface WaveLine {
        id: string;
        date: string;
        description: string;
        lineDescription: string;
        accountPath: string;
        amount: number;
        row: number;
    }

    /** Signed amount (debit positive) from whichever shape the export uses. */
    const lineAmount = (row: string[], rowNum: number): number | 'bad' => {
        const parse = (idx: number): number | null =>
            parseLocaleNumber(cellAt(row, idx), { decimal: locale.decimal });

        if (twoColumn) {
            const debitRaw = cellAt(row, cols.debit);
            const creditRaw = cellAt(row, cols.credit);
            if (debitRaw !== '' || creditRaw !== '' || cols.amount < 0) {
                const debit = parse(cols.debit);
                const credit = parse(cols.credit);
                if (debit === null || credit === null) {
                    errors.push({ row: rowNum, message: `Could not parse the debit/credit amount on row ${rowNum}.` });
                    return 'bad';
                }
                return round2(debit - credit);
            }
        }
        const amount = parse(cols.amount);
        if (amount === null) {
            errors.push({ row: rowNum, message: `Could not parse the amount on row ${rowNum}.` });
            return 'bad';
        }
        if (cols.indicator >= 0) {
            const ind = cellAt(row, cols.indicator).trim().toLowerCase();
            if (ind === 'credit' || ind === 'cr') return round2(-Math.abs(amount));
            if (ind === 'debit' || ind === 'dr') return round2(Math.abs(amount));
        }
        return amount; // signed one-column amount: debit positive
    };

    // 1. Collect lines
    const lines: WaveLine[] = [];
    const badGroups = new Set<string>(); // group keys poisoned by a bad amount
    let rowsRead = 0;

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
        const accountPath = canonicalAccountPath(cellAt(row, cols.account));
        if (!accountPath || /^total\b/i.test(accountPath)) continue;

        const id = hasId ? cellAt(row, cols.id).trim() : '';
        const description = cellAt(row, cols.description);
        const amount = lineAmount(row, rowNum);
        const groupKey = id !== '' ? `id:${id}` : `dd:${date} ${description.toLowerCase()}`;
        if (amount === 'bad') {
            badGroups.add(groupKey);
            continue;
        }
        lines.push({
            id,
            date,
            description,
            lineDescription: cellAt(row, cols.lineDescription),
            accountPath,
            amount,
            row: rowNum,
        });
    }

    // 2. Group: by Transaction ID when present, else CONSECUTIVE runs of the
    //    same (date + description) — two invoices with the same description
    //    on the same day merge only if their rows are adjacent, matching how
    //    Wave orders the export.
    const groups: Array<{ key: string; lines: WaveLine[] }> = [];
    const groupByKey = new Map<string, { key: string; lines: WaveLine[] }>();
    let lastRunKey: string | null = null;

    for (const line of lines) {
        if (line.id !== '') {
            const key = `id:${line.id}`;
            let g = groupByKey.get(key);
            if (!g) {
                g = { key, lines: [] };
                groupByKey.set(key, g);
                groups.push(g);
            }
            g.lines.push(line);
            lastRunKey = null;
        } else {
            const key = `dd:${line.date} ${line.description.toLowerCase()}`;
            if (key !== lastRunKey) {
                groups.push({ key, lines: [line] });
                lastRunKey = key;
            } else {
                groups[groups.length - 1].lines.push(line);
            }
        }
    }

    // 3. Validate balance and emit
    const transactions: QboJournalTransaction[] = [];
    for (const g of groups) {
        if (badGroups.has(g.key)) continue; // amount error already recorded
        const sum = round2(g.lines.reduce((s, l) => s + l.amount, 0));
        const first = g.lines[0];
        if (Math.abs(sum) > 0.01) {
            errors.push({
                row: first.row,
                message:
                    `Transaction on ${first.date}${first.description ? ` ("${first.description}")` : ''} does not balance: ` +
                    `lines (rows ${g.lines.map((l) => l.row).join(', ')}) sum to ${sum.toFixed(2)}, expected 0.00.`,
            });
            continue;
        }
        if (g.lines.length < 2) {
            // A lone zero line is a report artifact; a lone non-zero line was
            // caught by the balance check above.
            continue;
        }
        transactions.push({
            date: first.date,
            type: '',
            num: first.id,
            name: '',
            memo: first.description,
            lines: g.lines.map((l) => ({
                accountPath: l.accountPath,
                amount: l.amount,
                memo: l.lineDescription,
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

    if (!hasId && transactions.length > 0) {
        warnings.push(
            'No Transaction ID column found — rows were grouped by date and description. ' +
                'Distinct same-day transactions with identical descriptions may merge.'
        );
    }

    return {
        transactions,
        accountsSeen,
        errors,
        warnings,
        dateRange,
        companyName: null,
        rowsRead,
    };
}
