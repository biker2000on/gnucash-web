/**
 * QuickBooks Online General Ledger report parser (pure — no database access).
 *
 * The "Export data" ZIP (Settings gear → Tools → Export data) does not include
 * the Journal report, but it does include a General Ledger workbook. Its
 * layout differs from the Journal:
 *
 *   - account-name section header rows (only the first cell populated),
 *     possibly nested (sub-account sections inside their parent's section),
 *   - per-account transaction rows: Date, Transaction Type, Num, Name,
 *     Memo/Description, Split, signed Amount, running Balance,
 *   - "Beginning Balance" rows and "Total for X" closing rows.
 *
 * Every double-entry transaction appears once in EACH account it touches, so
 * we reconstruct transactions by grouping entries across accounts on
 * (date + transaction type + num + name-or-memo) and validating that each
 * group sums to ~0 (±0.01) — the GL Amount column is already signed
 * debit-positive / credit-negative, matching the Journal parser convention.
 *
 * Grouping semantics (deliberate, tested):
 *   - Distinct same-day transactions with identical type/num/name (e.g. two
 *     $50 cash sales with no Num) are indistinguishable in a GL export. They
 *     merge into ONE combined transaction with all their splits. The combined
 *     group still balances, per-account totals stay correct; only the
 *     transaction *count* undercounts. The Journal report keeps them separate.
 *   - If a group does NOT balance, we attempt subset matching only in the
 *     trivial case: exactly one pair of entries with opposite amounts exists
 *     in the group. That pair becomes a transaction; the leftover entries are
 *     reported as a row-numbered error. Anything more ambiguous is emitted as
 *     an error suggesting the Journal report export instead.
 *
 * Output shape is identical to the Journal parser (QboJournalParseResult) so
 * the service layer is format-agnostic; `glStats` adds reconstruction counts.
 */

import {
    canonicalAccountPath,
    extractCompanyName,
    normHeader,
    parseQboAmount,
    parseQboDate,
    round2,
    MAX_HEADER_SCAN_ROWS,
    type QboJournalParseResult,
    type QboJournalTransaction,
    type QboParseError,
} from './qbo-journal';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export interface QboGlStats {
    /** Balanced transactions successfully reconstructed */
    reconstructed: number;
    /** Groups (or group remainders) that could not be reconstructed */
    failed: number;
}

export interface QboGlParseResult extends QboJournalParseResult {
    glStats: QboGlStats;
}

interface GlColumns {
    date: number;
    type: number;
    num: number;
    name: number;
    memo: number;
    split: number;
    amount: number;
    balance: number;
}

interface GlEntry {
    accountPath: string;
    date: string;
    type: string;
    num: string;
    name: string;
    memo: string;
    /** Signed: debit positive, credit negative (as exported) */
    amount: number;
    /** 1-based row number in the original sheet */
    row: number;
}

/* ------------------------------------------------------------------ */
/* Header detection                                                     */
/* ------------------------------------------------------------------ */

/**
 * Detect a General Ledger header row: Date + signed Amount + running Balance,
 * and NO Debit/Credit columns (those mean it's a Journal or Trial Balance).
 */
export function detectGlHeader(cells: string[]): GlColumns | null {
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

    if (norm.some((c) => c.includes('debit')) || norm.some((c) => c.includes('credit'))) {
        return null;
    }
    const date = find('date', 'transaction date', (c) => c.endsWith('date'));
    const amount = find('amount', (c) => c.includes('amount'));
    const balance = find('balance', (c) => c.includes('balance'));
    if (date < 0 || amount < 0 || balance < 0) return null;

    return {
        date,
        amount,
        balance,
        type: find('transaction type', 'type', (c) => c.includes('transaction type')),
        num: find('num', 'no.', 'no', '#', 'number'),
        name: find('name', (c) => c === 'payee' || c === 'vendor' || c === 'customer'),
        memo: find('memo/description', 'memo', 'description', (c) => c.includes('memo')),
        split: find('split'),
    };
}

/* ------------------------------------------------------------------ */
/* Parser                                                               */
/* ------------------------------------------------------------------ */

export function parseQboGeneralLedgerRows(rows: string[][]): QboGlParseResult {
    const warnings: string[] = [];
    const errors: QboParseError[] = [];

    // 1. Locate the header row
    let headerIdx = -1;
    let cols: GlColumns | null = null;
    for (let i = 0; i < Math.min(rows.length, MAX_HEADER_SCAN_ROWS); i++) {
        const detected = detectGlHeader(rows[i]);
        if (detected) {
            headerIdx = i;
            cols = detected;
            break;
        }
    }
    if (headerIdx < 0 || !cols) {
        return emptyResult(
            rows,
            'Could not find the General Ledger header row (expected columns like Date, Transaction Type, Amount, Balance). ' +
                'Make sure this is a QuickBooks Online General Ledger report.'
        );
    }

    const companyName = extractCompanyName(rows.slice(0, headerIdx));
    if (cols.memo < 0) warnings.push('No Memo/Description column found in the General Ledger; memos will be empty.');

    const cell = (row: string[], idx: number): string =>
        idx >= 0 && idx < row.length ? row[idx] : '';

    // 2. Walk rows: track the account-section stack, collect entries
    const sectionStack: string[] = [];
    const entries: GlEntry[] = [];
    let rowsRead = 0;
    let orphanRowsReported = false;

    for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 1; // 1-based, matches the sheet
        if (row.every((c) => c === '')) continue;
        rowsRead++;

        const dateRaw = cell(row, cols.date);
        const iso = dateRaw !== '' ? parseQboDate(dateRaw) : null;

        if (iso) {
            // Transaction entry row
            if (sectionStack.length === 0) {
                if (!orphanRowsReported) {
                    errors.push({
                        row: rowNum,
                        message: 'Transaction row appears before any account section header; it was skipped.',
                    });
                    orphanRowsReported = true;
                }
                continue;
            }
            const amountRaw = cell(row, cols.amount);
            const amount = parseQboAmount(amountRaw);
            if (amount === null) {
                errors.push({
                    row: rowNum,
                    message: `Could not parse amount "${amountRaw}" in account "${sectionStack.join(':')}".`,
                });
                continue;
            }
            entries.push({
                accountPath: sectionStack.join(':'),
                date: iso,
                type: cell(row, cols.type),
                num: cell(row, cols.num),
                name: cell(row, cols.name),
                memo: cell(row, cols.memo),
                amount,
                row: rowNum,
            });
            continue;
        }

        // Non-entry row: label lives in the first non-empty cell (usually the
        // Date column; some exports have a leading blank column).
        const label = row.find((c) => c !== '') ?? '';
        if (/^beginning balance$/i.test(label)) continue;

        const totalMatch = label.match(/^total(?:\s+for\s+(.+))?$/i);
        if (totalMatch) {
            // Close the deepest matching open section (tolerant of mismatch).
            const target = totalMatch[1] ? canonicalAccountPath(totalMatch[1]).toLowerCase() : null;
            if (target) {
                const idx = sectionStack.map((s) => s.toLowerCase()).lastIndexOf(target);
                sectionStack.length = idx >= 0 ? idx : Math.max(sectionStack.length - 1, 0);
            } else if (sectionStack.length > 0) {
                sectionStack.pop();
            }
            continue;
        }

        // Account section header: a label row with no amount value.
        if (cell(row, cols.amount) === '') {
            const name = canonicalAccountPath(label);
            if (name !== '') sectionStack.push(name);
        }
        // Label rows WITH an amount are report artifacts we cannot attribute
        // (e.g. "Not Specified" summary lines) — skipped.
    }

    // 3. Group entries across accounts and reconstruct transactions
    const groups = new Map<string, GlEntry[]>();
    for (const e of entries) {
        const key = [
            e.date,
            e.type.toLowerCase(),
            e.num.toLowerCase(),
            (e.name || e.memo).toLowerCase(),
        ].join(String.fromCharCode(0));
        const arr = groups.get(key);
        if (arr) arr.push(e);
        else groups.set(key, [e]);
    }

    const transactions: QboJournalTransaction[] = [];
    let failed = 0;

    const emit = (group: GlEntry[]) => {
        transactions.push({
            date: group[0].date,
            type: group[0].type,
            num: group[0].num,
            name: group.find((e) => e.name !== '')?.name ?? '',
            memo: group.find((e) => e.memo !== '')?.memo ?? '',
            lines: group.map((e) => ({
                accountPath: e.accountPath,
                amount: e.amount,
                memo: e.memo,
                row: e.row,
            })),
            startRow: Math.min(...group.map((e) => e.row)),
        });
    };

    const failGroup = (group: GlEntry[], sum: number) => {
        failed++;
        const first = group[0];
        errors.push({
            row: Math.min(...group.map((e) => e.row)),
            message:
                `Could not reconstruct a balanced transaction for ${first.date}` +
                `${first.type ? ` ${first.type}` : ''}${first.name ? ` "${first.name}"` : ''} ` +
                `(rows ${group.map((e) => e.row).join(', ')}; entries sum to ${sum.toFixed(2)}, expected 0.00). ` +
                'Export the Journal report instead for these transactions.',
        });
    };

    for (const group of groups.values()) {
        const sum = round2(group.reduce((s, e) => s + e.amount, 0));
        if (Math.abs(sum) <= 0.01) {
            if (group.length >= 2) {
                emit(group);
            } else {
                // Single zero-amount entry: report artifact, drop silently.
            }
            continue;
        }

        // Unbalanced. Trivial subset matching only: exactly one pair of
        // entries with opposite (non-zero) amounts.
        const pairs: Array<[number, number]> = [];
        for (let i = 0; i < group.length; i++) {
            for (let j = i + 1; j < group.length; j++) {
                if (
                    Math.abs(group[i].amount) > 0.005 &&
                    Math.abs(round2(group[i].amount + group[j].amount)) <= 0.01
                ) {
                    pairs.push([i, j]);
                }
            }
        }
        if (pairs.length === 1) {
            const [i, j] = pairs[0];
            emit([group[i], group[j]]);
            const rest = group.filter((_, idx) => idx !== i && idx !== j);
            failGroup(rest, round2(rest.reduce((s, e) => s + e.amount, 0)));
        } else {
            failGroup(group, sum);
        }
    }

    // Stable output order: by date, then first row in the sheet.
    transactions.sort((a, b) =>
        a.date < b.date ? -1 : a.date > b.date ? 1 : a.startRow - b.startRow
    );

    // 4. Aggregate (same as the Journal parser)
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
        glStats: { reconstructed: transactions.length, failed },
    };
}

function emptyResult(rows: string[][], message: string): QboGlParseResult {
    return {
        transactions: [],
        accountsSeen: [],
        errors: [{ row: 1, message }],
        warnings: [],
        dateRange: null,
        companyName: extractCompanyName(rows.slice(0, Math.min(rows.length, MAX_HEADER_SCAN_ROWS))),
        rowsRead: 0,
        glStats: { reconstructed: 0, failed: 0 },
    };
}
