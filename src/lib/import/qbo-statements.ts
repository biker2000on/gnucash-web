/**
 * QuickBooks Online financial-statement parsers (pure — no database access).
 *
 * QBO's one-click "Export data" ZIP does NOT include the Chart of Accounts,
 * but it does include a Balance Sheet and a Profit and Loss workbook. Both
 * list every account under QBO's type sections:
 *
 *   Balance Sheet:  ASSETS › Current Assets › Bank Accounts › <account>
 *                   LIABILITIES AND EQUITY › Liabilities › Credit Cards › ...
 *   Profit and Loss: Income › <account>, Cost of Goods Sold › ..., Expenses › ...
 *
 * The section an account sits under IS its QBO account type, so the two
 * reports together are as good as a Chart of Accounts for typing the
 * imported ledger. This module turns them into a QboCoaParseResult
 * (derivedFrom: 'statements') that resolveAccountTypes() consumes unchanged.
 *
 * Layout facts the parser relies on (the sheet rows are trimmed, so
 * indentation is NOT available):
 *   - column 0 holds the label; any later column holds an amount,
 *   - a section or parent account is a label row followed by its children
 *     and closed by a "Total <label>" row — that closing row is the only
 *     reliable structural signal, so parent/leaf is decided by matching
 *     each "Total X" back to the nearest open row named X,
 *   - a parent account may carry its own amount (it was posted to directly),
 *   - computed rows (Net Income, Gross Profit, ...) are not accounts.
 */

import { canonicalAccountPath, normHeader, type QboCoaAccount, type QboCoaParseResult } from './qbo-journal';

export type StatementKind = 'balance_sheet' | 'profit_and_loss';

const MAX_TITLE_SCAN_ROWS = 10;

const BALANCE_SHEET_TITLES = new Set(['balance sheet', 'balance sheet report', 'statement of financial position']);
const PROFIT_AND_LOSS_TITLES = new Set([
    'profit and loss',
    'profit & loss',
    'profit and loss report',
    'income statement',
    'statement of activity',
]);

/**
 * QBO section labels → GnuCash account type. Keys are normalized (lower
 * case, single spaces). Sections nest (ASSETS › Current Assets › Bank
 * Accounts); the innermost matching ancestor decides the type.
 */
const SECTION_TYPES: Record<string, string> = {
    // Balance Sheet
    assets: 'ASSET',
    'total assets': 'ASSET',
    'current assets': 'ASSET',
    'bank accounts': 'BANK',
    'accounts receivable': 'RECEIVABLE',
    'other current assets': 'ASSET',
    'fixed assets': 'ASSET',
    'other assets': 'ASSET',
    'liabilities and equity': 'LIABILITY',
    liabilities: 'LIABILITY',
    'current liabilities': 'LIABILITY',
    'accounts payable': 'PAYABLE',
    'credit cards': 'CREDIT',
    'other current liabilities': 'LIABILITY',
    'long-term liabilities': 'LIABILITY',
    'long term liabilities': 'LIABILITY',
    equity: 'EQUITY',
    // Profit and Loss
    income: 'INCOME',
    'other income': 'INCOME',
    'cost of goods sold': 'EXPENSE',
    'cost of sales': 'EXPENSE',
    expenses: 'EXPENSE',
    'other expenses': 'EXPENSE',
};

/** Report rows that are arithmetic, not accounts. */
const COMPUTED_ROWS = new Set([
    'net income',
    'net loss',
    'net operating income',
    'net other income',
    'gross profit',
    'total',
]);

/* ------------------------------------------------------------------ */
/* Detection                                                            */
/* ------------------------------------------------------------------ */

/**
 * Detect a Balance Sheet or Profit and Loss report by its title row (in the
 * preamble) plus at least one top-level QBO section label. Returns null for
 * anything else — including the Trial Balance, which has no sections.
 */
export function detectStatementKind(rows: string[][]): StatementKind | null {
    let kind: StatementKind | null = null;
    for (let i = 0; i < Math.min(rows.length, MAX_TITLE_SCAN_ROWS); i++) {
        const text = normHeader(rows[i].filter((c) => c !== '').join(' '));
        if (BALANCE_SHEET_TITLES.has(text)) kind = 'balance_sheet';
        else if (PROFIT_AND_LOSS_TITLES.has(text)) kind = 'profit_and_loss';
        if (kind) break;
    }
    if (!kind) return null;

    const hasSection = rows.some((row) => {
        const label = normHeader(row[0] ?? '');
        return label !== '' && label in SECTION_TYPES && !hasAmountCell(row);
    });
    return hasSection ? kind : null;
}

/* ------------------------------------------------------------------ */
/* Parsing                                                              */
/* ------------------------------------------------------------------ */

interface OpenRow {
    /** Row label, canonicalized */
    name: string;
    /** Sheet row index */
    index: number;
    /**
     * Leaf accounts always print an amount (QBO shows "0.00" even for empty
     * ones); a label row WITHOUT one is a section or a placeholder parent
     * and therefore always has a closing "Total <name>" row. When a leaf
     * shares its parent's name ("Travel › Travel"), the Total must go to the
     * amount-less row.
     */
    header: boolean;
}

function hasAmountCell(row: string[]): boolean {
    for (let c = 1; c < row.length; c++) {
        if (row[c] !== '') return true;
    }
    return false;
}

function totalTarget(label: string): string | null {
    const m = label.match(/^total(?:\s+for)?\s+(.+)$/i);
    return m ? canonicalAccountPath(m[1]) : null;
}

function isComputedRow(label: string): boolean {
    const n = normHeader(label);
    if (COMPUTED_ROWS.has(n)) return true;
    if (n.startsWith('total ')) return true;
    // Trailing report footer: "Tuesday, Sep 01, 2026 12:20:27 PM GMT-7 - Accrual Basis"
    if (/\b(accrual|cash) basis\b/.test(n)) return true;
    return false;
}

/**
 * Parse one statement sheet into CoA-shaped accounts. Every account row
 * (leaf or parent-with-children) becomes an entry whose fullName is the
 * colon path BELOW the type sections, e.g. "Payroll Liabilities:401K".
 */
export function parseQboStatementRows(rows: string[][], kind: StatementKind): QboCoaParseResult {
    const warnings: string[] = [];
    const reportName = kind === 'balance_sheet' ? 'Balance Sheet' : 'Profit and Loss';

    // Pass 1: decide which label rows are parents by matching "Total X"
    // rows back to the nearest open row named X (parentheses matching).
    const open: OpenRow[] = [];
    const parents = new Set<number>();
    for (let i = 0; i < rows.length; i++) {
        const label = canonicalAccountPath(rows[i]?.[0] ?? '');
        if (label === '') continue;
        const target = totalTarget(label);
        if (target !== null) {
            const key = target.toLowerCase();
            const matches = (j: number) => open[j].name.toLowerCase() === key;
            let found = -1;
            for (let j = open.length - 1; j >= 0 && found < 0; j--) {
                if (matches(j) && open[j].header) found = j;
            }
            for (let j = open.length - 1; j >= 0 && found < 0; j--) {
                if (matches(j)) found = j;
            }
            if (found >= 0) {
                parents.add(open[found].index);
                open.length = found; // close it and everything nested after it
            }
            continue;
        }
        if (isComputedRow(label)) continue;
        open.push({ name: label, index: i, header: !hasAmountCell(rows[i]) });
    }

    // Pass 2: walk with a stack of (name, isSection) building paths.
    interface Frame {
        name: string;
        isSection: boolean;
        gnucashType: string | null;
    }
    const stack: Frame[] = [];
    const accounts: QboCoaAccount[] = [];
    const seen = new Set<string>();

    const currentType = (): string | null => {
        for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i].isSection && stack[i].gnucashType) return stack[i].gnucashType;
        }
        return null;
    };
    const accountPathOf = (leaf: string): string =>
        [...stack.filter((f) => !f.isSection).map((f) => f.name), leaf].join(':');

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i] ?? [];
        const label = canonicalAccountPath(row[0] ?? '');
        if (label === '') continue;

        const target = totalTarget(label);
        if (target !== null) {
            const key = target.toLowerCase();
            for (let j = stack.length - 1; j >= 0; j--) {
                if (stack[j].name.toLowerCase() === key) {
                    stack.length = j;
                    break;
                }
            }
            continue;
        }
        if (isComputedRow(label)) continue;

        const isParent = parents.has(i);
        const norm = normHeader(label);
        const sectionType = SECTION_TYPES[norm];
        // A section: a known section label with no amount, nested only in
        // sections, and not repeating an ancestor section's name (QBO's
        // "Cost of Goods Sold" section contains an account of the same name).
        const ancestorSections = stack.filter((f) => f.isSection).map((f) => normHeader(f.name));
        const isSection =
            sectionType !== undefined &&
            !hasAmountCell(row) &&
            stack.every((f) => f.isSection) &&
            !ancestorSections.includes(norm);

        if (isSection) {
            if (isParent) stack.push({ name: label, isSection: true, gnucashType: sectionType });
            // A section with no children (no Total row) contributes nothing.
            continue;
        }

        if (stack.length === 0) {
            // Top-level label that is not a section: report footer or an
            // unknown section label. Skip it (and its subtree, if any).
            if (isParent) stack.push({ name: label, isSection: true, gnucashType: null });
            continue;
        }

        const gnucashType = currentType();
        const fullName = accountPathOf(label);
        const key = fullName.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            if (gnucashType === null) {
                warnings.push(
                    `"${fullName}" sits under an unrecognized ${reportName} section; it will default to ASSET.`
                );
            }
            accounts.push({
                fullName,
                qboType: stack.filter((f) => f.isSection).map((f) => f.name).join(' › ') || reportName,
                detailType: '',
                gnucashType,
            });
        }
        if (isParent) stack.push({ name: label, isSection: false, gnucashType });
    }

    return {
        accounts,
        warnings,
        errors:
            accounts.length === 0
                ? [{ row: 1, message: `No accounts found in the ${reportName} report.` }]
                : [],
        derivedFrom: 'statements',
    };
}

/**
 * Merge the Balance Sheet and Profit and Loss account lists into one
 * CoA-shaped result (first occurrence of a path wins). Returns null when
 * neither report yielded accounts.
 */
export function coaFromStatements(
    parts: Array<{ rows: string[][]; kind: StatementKind }>
): QboCoaParseResult | null {
    const accounts: QboCoaAccount[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    for (const part of parts) {
        const parsed = parseQboStatementRows(part.rows, part.kind);
        warnings.push(...parsed.warnings);
        for (const a of parsed.accounts) {
            const key = a.fullName.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            accounts.push(a);
        }
    }
    if (accounts.length === 0) return null;
    return { accounts, warnings, errors: [], derivedFrom: 'statements' };
}
