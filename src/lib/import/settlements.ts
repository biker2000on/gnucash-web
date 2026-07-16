/**
 * Payment-processor settlement parsers (pure — no database access).
 *
 * Stripe / Square / PayPal / Shopify payout exports all reduce to one row per
 * balance event. Each row is normalized to a SettlementRecord:
 *
 *   { date, kind, gross, fee, net, reference, description }
 *
 * with the invariant  net = gross - fee  (checked to the cent; rows that do
 * not satisfy it are reported as errors, since the double-entry transaction
 * built from them could not balance).
 *
 * Sign conventions (GnuCash debit-positive):
 *   - sale:     gross > 0, fee >= 0, net = gross - fee
 *   - refund:   gross < 0 (money returned), fee <= 0 when the processor
 *               returns its fee, net < 0
 *   - fee_only: gross = 0, fee > 0, net = -fee (standalone processor charges)
 *   - payout:   net is the SIGNED change to the processor balance
 *               (negative = money moved to the bank). gross/fee unused.
 *   - other:    adjustments etc. — same shape as sale/refund.
 *
 * The two-to-three-split transaction for each row is produced by
 * buildSettlementSplits():
 *   - non-payout: clearing +net / fees +fee / income -gross  (sums to 0)
 *   - payout:     clearing +net / bank -net
 * so the processor clearing account nets toward zero and bank deposits match
 * the real payouts.
 *
 * Format assumptions per source:
 *   - Stripe (Balance / payout reconciliation report CSV): id, Type
 *     (charge/refund/payout/adjustment/...), Created (UTC) or Available On,
 *     Amount, Fee, Net, Currency, Description. Amount is signed; Net =
 *     Amount - Fee. Timestamps ("2025-01-15 10:23") are tolerated — the date
 *     part is used.
 *   - Square (Transactions CSV): Date, Gross Sales, Discounts, Net Sales,
 *     Tax, Tip, Fees, Net Total, Transaction ID. Square exports Fees as a
 *     NEGATIVE number on sales; gross = Net Sales + Tax + Tip (Discounts are
 *     already inside Net Sales), fee = -Fees, net = Net Total. No payout rows
 *     (Square payouts arrive via the bank feed).
 *   - PayPal (Activity CSV): Date, Name, Type, Status, Currency, Gross, Fee,
 *     Net, Transaction ID. Only Status = Completed rows import (others are
 *     counted and skipped). PayPal exports Fee as a NEGATIVE number; fee =
 *     -Fee, net = Gross + Fee as exported. "General Withdrawal" / transfers
 *     to bank are payout rows.
 *   - Shopify (Payout transactions CSV): Transaction Date / Payout Date, Type
 *     (charge/refund/payout/adjustment), Order, Amount, Fee, Net. Fee is
 *     positive; payout rows carry a negative Amount/Net. The payout SUMMARY
 *     CSV (Payout Date, Status, ..., Total) is also accepted — every row
 *     becomes a payout record. Reference is "<order>/<kind>" since one order
 *     can have both a charge and refund row (a second partial refund on the
 *     same order collides and is deduped — documented limitation).
 *
 * Duplicate stamps: dedupeStamp() returns '<source>:<reference>' which the
 * service writes into transactions.num and matches on re-import.
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
    isAmbiguousDate,
    type ColumnSpec,
} from './personal-import';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export type SettlementSource = 'stripe' | 'square' | 'paypal' | 'shopify';
export type SettlementKind = 'sale' | 'refund' | 'fee_only' | 'payout' | 'other';

export const SETTLEMENT_SOURCES: readonly SettlementSource[] = [
    'stripe',
    'square',
    'paypal',
    'shopify',
] as const;

export const SETTLEMENT_SOURCE_LABELS: Record<SettlementSource, string> = {
    stripe: 'Stripe',
    square: 'Square',
    paypal: 'PayPal',
    shopify: 'Shopify',
};

export function isSettlementSource(s: string): s is SettlementSource {
    return (SETTLEMENT_SOURCES as readonly string[]).includes(s);
}

export interface SettlementRecord {
    /** ISO YYYY-MM-DD */
    date: string;
    kind: SettlementKind;
    /** Amount charged to the customer (0 for payout rows) */
    gross: number;
    /** Processor fee, positive on sales, negative when returned on refunds */
    fee: number;
    /** Signed change to the processor balance (clearing account) */
    net: number;
    /** Processor reference id ('' when the export has none) */
    reference: string;
    description: string;
    /** ISO currency code when the export carries one, else '' */
    currency: string;
    /** 1-based row number in the original file */
    row: number;
}

export interface SettlementParseError {
    row: number;
    message: string;
}

export interface SettlementParseResult {
    records: SettlementRecord[];
    errors: SettlementParseError[];
    warnings: string[];
    dateRange: { start: string; end: string } | null;
    /** Data rows examined (excludes header + blank rows) */
    rowsRead: number;
    /** Rows whose numeric date parses differently day-first vs month-first */
    ambiguousDateRows: number;
    /** Rows skipped because their status was not final (PayPal non-Completed) */
    statusSkipped: number;
}

/** Roles a settlement split can post to. */
export type SettlementRole = 'income' | 'fees' | 'clearing' | 'bank';

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/**
 * Stamp written into transactions.num so re-imports of the same export are
 * detected: '<source>:<reference>'. Null when the row has no reference.
 */
export function dedupeStamp(source: SettlementSource, reference: string): string | null {
    const ref = reference.trim();
    return ref === '' ? null : `${source}:${ref}`;
}

/**
 * Parse a settlement date cell. Processor exports often carry timestamps
 * ("2025-01-15 10:23:00" / "2025-01-15T10:23:00Z") — the date part is used.
 */
export function parseSettlementDate(
    raw: string,
    locale: ImportLocale = DEFAULT_LOCALE
): string | null {
    const s = raw.trim();
    if (!s) return null;
    const direct = parseLocaleDate(s, { dayFirst: locale.dayFirst });
    if (direct) return direct;
    const token = s.split(/[T\s]/)[0];
    if (token && token !== s) return parseLocaleDate(token, { dayFirst: locale.dayFirst });
    return null;
}

/**
 * Splits for one settlement record, as (role, amount) pairs summing to zero.
 * Zero-amount legs are dropped; a record with no non-zero legs returns [].
 */
export function buildSettlementSplits(
    r: SettlementRecord
): Array<{ role: SettlementRole; amount: number }> {
    const splits: Array<{ role: SettlementRole; amount: number }> = [];
    const push = (role: SettlementRole, amount: number) => {
        const a = round2(amount);
        if (Math.abs(a) >= 0.005) splits.push({ role, amount: a });
    };

    if (r.kind === 'payout') {
        push('clearing', r.net);
        push('bank', -r.net);
        return splits;
    }
    push('clearing', r.net);
    push('fees', r.fee);
    push('income', -r.gross);
    return splits;
}

interface RowContext {
    records: SettlementRecord[];
    errors: SettlementParseError[];
    warnings: string[];
    rowsRead: number;
    ambiguousDateRows: number;
    statusSkipped: number;
    currencies: Set<string>;
}

function newContext(): RowContext {
    return {
        records: [],
        errors: [],
        warnings: [],
        rowsRead: 0,
        ambiguousDateRows: 0,
        statusSkipped: 0,
        currencies: new Set(),
    };
}

function finalize(ctx: RowContext): SettlementParseResult {
    let dateRange: SettlementParseResult['dateRange'] = null;
    for (const r of ctx.records) {
        if (!dateRange) dateRange = { start: r.date, end: r.date };
        else {
            if (r.date < dateRange.start) dateRange.start = r.date;
            if (r.date > dateRange.end) dateRange.end = r.date;
        }
    }
    if (ctx.currencies.size > 1) {
        ctx.warnings.push(
            `The file mixes currencies (${Array.from(ctx.currencies).sort().join(', ')}). ` +
                'All amounts import at face value into the book currency — split the export per currency if that is wrong.'
        );
    }
    return {
        records: ctx.records,
        errors: ctx.errors,
        warnings: ctx.warnings,
        dateRange,
        rowsRead: ctx.rowsRead,
        ambiguousDateRows: ctx.ambiguousDateRows,
        statusSkipped: ctx.statusSkipped,
    };
}

function headerError(source: SettlementSource, expected: string): SettlementParseResult {
    const ctx = newContext();
    ctx.errors.push({
        row: 1,
        message:
            `Could not find the ${SETTLEMENT_SOURCE_LABELS[source]} header row (expected columns like ${expected}). ` +
            `Make sure this is a ${SETTLEMENT_SOURCE_LABELS[source]} export CSV.`,
    });
    return finalize(ctx);
}

/**
 * Validate net = gross - fee (to the cent, with a 1-cent rounding tolerance)
 * and push the record. Rows violating the identity cannot produce a balanced
 * transaction and are reported as errors.
 */
function pushChecked(ctx: RowContext, r: SettlementRecord): void {
    // Standalone processor fees are usually exported as a signed Amount with
    // Fee 0 (e.g. Stripe "stripe_fee": Amount -2.00, Net -2.00). Reshape so
    // the charge posts to the fee expense account instead of contra income.
    if (r.kind === 'fee_only' && Math.abs(r.fee) < 0.005) {
        r = { ...r, gross: 0, fee: round2(-r.net) };
    }
    if (r.kind !== 'payout') {
        const diff = round2(r.net + r.fee - r.gross);
        if (Math.abs(diff) > 0.011) {
            ctx.errors.push({
                row: r.row,
                message:
                    `Amounts do not reconcile on ${r.date} (gross ${r.gross.toFixed(2)}, fee ${r.fee.toFixed(2)}, ` +
                    `net ${r.net.toFixed(2)}): net + fee - gross = ${diff.toFixed(2)}, expected 0.00.`,
            });
            return;
        }
    }
    if (r.currency) ctx.currencies.add(r.currency);
    ctx.records.push(r);
}

/* ------------------------------------------------------------------ */
/* Stripe                                                               */
/* ------------------------------------------------------------------ */

const STRIPE_COLUMNS: ColumnSpec[] = [
    { key: 'date', names: ['created (utc)', 'created', 'available on (utc)', 'available on', 'date'], required: true },
    { key: 'type', names: ['type'], required: true },
    { key: 'amount', names: ['amount'], required: true },
    { key: 'fee', names: ['fee', 'fees'] },
    { key: 'net', names: ['net'] },
    { key: 'currency', names: ['currency'] },
    { key: 'description', names: ['description'] },
    { key: 'id', names: ['id', 'balance transaction id', 'source'] },
];

function stripeKind(type: string): SettlementKind {
    const t = type.trim().toLowerCase();
    if (t.includes('refund')) return 'refund';
    if (t.includes('payout') || t === 'transfer') return 'payout';
    if (t.includes('charge') || t.includes('payment')) return 'sale';
    if (t.includes('fee')) return 'fee_only';
    return 'other';
}

export function parseStripeSettlementCsv(
    content: string,
    locale: ImportLocale = DEFAULT_LOCALE
): SettlementParseResult {
    const rows = splitCsvRows(content);
    const header = detectHeaderRow(rows, STRIPE_COLUMNS);
    if (!header) return headerError('stripe', 'Created (UTC), Type, Amount, Fee, Net');
    const { headerIdx, cols } = header;
    const ctx = newContext();
    if (cols.id < 0) ctx.warnings.push('No id column found; duplicate detection is unavailable for this file.');

    for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 1;
        if (row.every((c) => c === '')) continue;
        ctx.rowsRead++;

        const dateRaw = cellAt(row, cols.date);
        const date = parseSettlementDate(dateRaw, locale);
        if (!date) {
            ctx.errors.push({ row: rowNum, message: `Unrecognized date "${dateRaw}".` });
            continue;
        }
        if (isAmbiguousDate(dateRaw.split(/[T\s]/)[0])) ctx.ambiguousDateRows++;

        const amount = parseLocaleNumber(cellAt(row, cols.amount), { decimal: locale.decimal });
        const feeCell = parseLocaleNumber(cellAt(row, cols.fee), { decimal: locale.decimal });
        const netCell = parseLocaleNumber(cellAt(row, cols.net), { decimal: locale.decimal });
        if (amount === null || feeCell === null || netCell === null) {
            ctx.errors.push({ row: rowNum, message: `Could not parse an amount on row ${rowNum}.` });
            continue;
        }

        const kind = stripeKind(cellAt(row, cols.type));
        const fee = feeCell;
        const net = cols.net >= 0 && cellAt(row, cols.net) !== '' ? netCell : round2(amount - fee);
        pushChecked(ctx, {
            date,
            kind,
            gross: kind === 'payout' ? 0 : amount,
            fee: kind === 'payout' ? 0 : fee,
            net: kind === 'payout' ? (cellAt(row, cols.net) !== '' ? net : amount) : net,
            reference: cellAt(row, cols.id),
            description: cellAt(row, cols.description) || cellAt(row, cols.type),
            currency: cellAt(row, cols.currency).toUpperCase(),
            row: rowNum,
        });
    }
    return finalize(ctx);
}

/* ------------------------------------------------------------------ */
/* Square                                                               */
/* ------------------------------------------------------------------ */

const SQUARE_COLUMNS: ColumnSpec[] = [
    { key: 'date', names: ['date'], required: true },
    { key: 'grossSales', names: ['gross sales'], required: true },
    { key: 'discounts', names: ['discounts'] },
    { key: 'netSales', names: ['net sales'] },
    { key: 'tax', names: ['tax'] },
    { key: 'tip', names: ['tip', 'tips'] },
    { key: 'fees', names: ['fees', 'square fees'] },
    { key: 'netTotal', names: ['net total', 'total collected'] },
    { key: 'id', names: ['transaction id', 'payment id'] },
    { key: 'description', names: ['description', 'details'] },
];

export function parseSquareSettlementCsv(
    content: string,
    locale: ImportLocale = DEFAULT_LOCALE
): SettlementParseResult {
    const rows = splitCsvRows(content);
    const header = detectHeaderRow(rows, SQUARE_COLUMNS);
    if (!header) return headerError('square', 'Date, Gross Sales, Net Sales, Fees, Net Total, Transaction ID');
    const { headerIdx, cols } = header;
    const ctx = newContext();
    if (cols.id < 0) ctx.warnings.push('No Transaction ID column found; duplicate detection is unavailable for this file.');

    for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 1;
        if (row.every((c) => c === '')) continue;
        ctx.rowsRead++;

        const dateRaw = cellAt(row, cols.date);
        const date = parseSettlementDate(dateRaw, locale);
        if (!date) {
            ctx.errors.push({ row: rowNum, message: `Unrecognized date "${dateRaw}".` });
            continue;
        }
        if (isAmbiguousDate(dateRaw.split(/[T\s]/)[0])) ctx.ambiguousDateRows++;

        const num = (key: number): number | null =>
            parseLocaleNumber(cellAt(row, key), { decimal: locale.decimal });
        const grossSales = num(cols.grossSales);
        const discounts = num(cols.discounts);
        const netSales = num(cols.netSales);
        const tax = num(cols.tax);
        const tip = num(cols.tip);
        const feesCell = num(cols.fees);
        const netTotal = num(cols.netTotal);
        if (
            grossSales === null || discounts === null || netSales === null ||
            tax === null || tip === null || feesCell === null || netTotal === null
        ) {
            ctx.errors.push({ row: rowNum, message: `Could not parse an amount on row ${rowNum}.` });
            continue;
        }

        // Discounts are already reflected in Net Sales; gross = money charged
        // to the customer. Square exports Fees negative on sales.
        const base = cols.netSales >= 0 ? netSales : round2(grossSales + discounts);
        const gross = round2(base + tax + tip);
        const fee = round2(-feesCell);
        const net = cols.netTotal >= 0 && cellAt(row, cols.netTotal) !== '' ? netTotal : round2(gross - fee);

        pushChecked(ctx, {
            date,
            kind: gross < 0 ? 'refund' : gross === 0 && fee !== 0 ? 'fee_only' : 'sale',
            gross,
            fee,
            net,
            reference: cellAt(row, cols.id),
            description: cellAt(row, cols.description) || 'Square sale',
            currency: '',
            row: rowNum,
        });
    }
    return finalize(ctx);
}

/* ------------------------------------------------------------------ */
/* PayPal                                                               */
/* ------------------------------------------------------------------ */

const PAYPAL_COLUMNS: ColumnSpec[] = [
    { key: 'date', names: ['date'], required: true },
    { key: 'name', names: ['name'] },
    { key: 'type', names: ['type'], required: true },
    { key: 'status', names: ['status'], required: true },
    { key: 'currency', names: ['currency'] },
    { key: 'gross', names: ['gross'], required: true },
    { key: 'fee', names: ['fee', 'fees'] },
    { key: 'net', names: ['net'] },
    { key: 'id', names: ['transaction id', 'txn id'] },
];

function paypalKind(type: string, gross: number): SettlementKind {
    const t = type.trim().toLowerCase();
    if (t.includes('refund') || t.includes('reversal') || t.includes('chargeback')) return 'refund';
    if (
        t.includes('withdrawal') ||
        t.includes('transfer to bank') ||
        (t.includes('bank deposit') && t.includes('pp')) ||
        t === 'payout'
    )
        return 'payout';
    if (t.includes('fee')) return 'fee_only';
    if (t.includes('hold') || t.includes('release')) return 'other';
    return gross !== 0 ? 'sale' : 'other';
}

export function parsePaypalSettlementCsv(
    content: string,
    locale: ImportLocale = DEFAULT_LOCALE
): SettlementParseResult {
    const rows = splitCsvRows(content);
    const header = detectHeaderRow(rows, PAYPAL_COLUMNS);
    if (!header) return headerError('paypal', 'Date, Name, Type, Status, Gross, Fee, Net');
    const { headerIdx, cols } = header;
    const ctx = newContext();
    if (cols.id < 0) ctx.warnings.push('No Transaction ID column found; duplicate detection is unavailable for this file.');

    for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 1;
        if (row.every((c) => c === '')) continue;
        ctx.rowsRead++;

        // Only finalized activity imports.
        const status = cellAt(row, cols.status).trim().toLowerCase();
        if (status !== 'completed') {
            ctx.statusSkipped++;
            continue;
        }

        const dateRaw = cellAt(row, cols.date);
        const date = parseSettlementDate(dateRaw, locale);
        if (!date) {
            ctx.errors.push({ row: rowNum, message: `Unrecognized date "${dateRaw}".` });
            continue;
        }
        if (isAmbiguousDate(dateRaw.split(/[T\s]/)[0])) ctx.ambiguousDateRows++;

        const gross = parseLocaleNumber(cellAt(row, cols.gross), { decimal: locale.decimal });
        const feeCell = parseLocaleNumber(cellAt(row, cols.fee), { decimal: locale.decimal });
        const netCell = parseLocaleNumber(cellAt(row, cols.net), { decimal: locale.decimal });
        if (gross === null || feeCell === null || netCell === null) {
            ctx.errors.push({ row: rowNum, message: `Could not parse an amount on row ${rowNum}.` });
            continue;
        }

        // PayPal exports Fee negative on sales; normalize to positive.
        const fee = round2(-feeCell);
        const net = cols.net >= 0 && cellAt(row, cols.net) !== '' ? netCell : round2(gross - fee);
        const kind = paypalKind(cellAt(row, cols.type), gross);

        pushChecked(ctx, {
            date,
            kind,
            gross: kind === 'payout' ? 0 : gross,
            fee: kind === 'payout' ? 0 : fee,
            net,
            reference: cellAt(row, cols.id),
            description: cellAt(row, cols.name) || cellAt(row, cols.type),
            currency: cellAt(row, cols.currency).toUpperCase(),
            row: rowNum,
        });
    }

    if (ctx.statusSkipped > 0) {
        ctx.warnings.push(
            `${ctx.statusSkipped} row${ctx.statusSkipped === 1 ? '' : 's'} with a non-Completed status ` +
                '(Pending, Denied, ...) were skipped.'
        );
    }
    return finalize(ctx);
}

/* ------------------------------------------------------------------ */
/* Shopify                                                              */
/* ------------------------------------------------------------------ */

const SHOPIFY_TXN_COLUMNS: ColumnSpec[] = [
    { key: 'date', names: ['transaction date', 'payout date', 'date'], required: true },
    { key: 'type', names: ['type'], required: true },
    { key: 'order', names: ['order', 'order id'] },
    { key: 'amount', names: ['amount'], required: true },
    { key: 'fee', names: ['fee', 'fees'] },
    { key: 'net', names: ['net'] },
    { key: 'payoutId', names: ['payout id'] },
    { key: 'currency', names: ['currency'] },
];

const SHOPIFY_SUMMARY_COLUMNS: ColumnSpec[] = [
    { key: 'date', names: ['payout date', 'date'], required: true },
    { key: 'total', names: ['total', 'total amount'], required: true },
    { key: 'status', names: ['status', 'payout status'] },
    { key: 'payoutId', names: ['payout id'] },
];

function shopifyKind(type: string): SettlementKind {
    const t = type.trim().toLowerCase();
    if (t.includes('refund')) return 'refund';
    if (t.includes('payout')) return 'payout';
    if (t.includes('charge')) return 'sale';
    if (t.includes('fee')) return 'fee_only';
    return 'other';
}

export function parseShopifySettlementCsv(
    content: string,
    locale: ImportLocale = DEFAULT_LOCALE
): SettlementParseResult {
    const rows = splitCsvRows(content);

    const txnHeader = detectHeaderRow(rows, SHOPIFY_TXN_COLUMNS);
    if (txnHeader) return parseShopifyTransactions(rows, txnHeader.headerIdx, txnHeader.cols, locale);

    // Payout SUMMARY export: one row per payout (no per-charge detail).
    const sumHeader = detectHeaderRow(rows, SHOPIFY_SUMMARY_COLUMNS);
    if (sumHeader) return parseShopifySummary(rows, sumHeader.headerIdx, sumHeader.cols, locale);

    return headerError('shopify', 'Transaction Date, Type, Order, Amount, Fee, Net — or Payout Date, Total');
}

function parseShopifyTransactions(
    rows: string[][],
    headerIdx: number,
    cols: Record<string, number>,
    locale: ImportLocale
): SettlementParseResult {
    const ctx = newContext();
    if (cols.order < 0 && cols.payoutId < 0) {
        ctx.warnings.push('No Order or Payout ID column found; duplicate detection is unavailable for this file.');
    }

    for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 1;
        if (row.every((c) => c === '')) continue;
        ctx.rowsRead++;

        const dateRaw = cellAt(row, cols.date);
        const date = parseSettlementDate(dateRaw, locale);
        if (!date) {
            ctx.errors.push({ row: rowNum, message: `Unrecognized date "${dateRaw}".` });
            continue;
        }
        if (isAmbiguousDate(dateRaw.split(/[T\s]/)[0])) ctx.ambiguousDateRows++;

        const amount = parseLocaleNumber(cellAt(row, cols.amount), { decimal: locale.decimal });
        const feeCell = parseLocaleNumber(cellAt(row, cols.fee), { decimal: locale.decimal });
        const netCell = parseLocaleNumber(cellAt(row, cols.net), { decimal: locale.decimal });
        if (amount === null || feeCell === null || netCell === null) {
            ctx.errors.push({ row: rowNum, message: `Could not parse an amount on row ${rowNum}.` });
            continue;
        }

        const typeRaw = cellAt(row, cols.type);
        const kind = shopifyKind(typeRaw);
        const net = cols.net >= 0 && cellAt(row, cols.net) !== '' ? netCell : round2(amount - feeCell);

        // One order can carry both a charge and a refund row — keep the
        // stamps distinct by appending the kind.
        const order = cellAt(row, cols.order);
        const reference = order
            ? `${order}/${kind}`
            : kind === 'payout'
                ? cellAt(row, cols.payoutId)
                : '';

        pushChecked(ctx, {
            date,
            kind,
            gross: kind === 'payout' ? 0 : amount,
            fee: kind === 'payout' ? 0 : feeCell,
            net,
            reference,
            description: order ? `Shopify ${typeRaw || kind} ${order}` : `Shopify ${typeRaw || kind}`,
            currency: cellAt(row, cols.currency).toUpperCase(),
            row: rowNum,
        });
    }
    return finalize(ctx);
}

function parseShopifySummary(
    rows: string[][],
    headerIdx: number,
    cols: Record<string, number>,
    locale: ImportLocale
): SettlementParseResult {
    const ctx = newContext();
    ctx.warnings.push(
        'This looks like the Shopify payout SUMMARY export — only payout rows are created. ' +
            'For gross/fee/refund detail, export the payout transactions CSV instead.'
    );

    for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 1;
        if (row.every((c) => c === '')) continue;
        ctx.rowsRead++;

        const dateRaw = cellAt(row, cols.date);
        const date = parseSettlementDate(dateRaw, locale);
        if (!date) {
            ctx.errors.push({ row: rowNum, message: `Unrecognized date "${dateRaw}".` });
            continue;
        }
        if (isAmbiguousDate(dateRaw.split(/[T\s]/)[0])) ctx.ambiguousDateRows++;

        const total = parseLocaleNumber(cellAt(row, cols.total), { decimal: locale.decimal });
        if (total === null) {
            ctx.errors.push({ row: rowNum, message: `Could not parse the payout total on row ${rowNum}.` });
            continue;
        }

        // A paid-out total of X reduces the processor balance by X.
        pushChecked(ctx, {
            date,
            kind: 'payout',
            gross: 0,
            fee: 0,
            net: round2(-total),
            reference: cellAt(row, cols.payoutId),
            description: `Shopify payout${cellAt(row, cols.status) ? ` (${cellAt(row, cols.status)})` : ''}`,
            currency: '',
            row: rowNum,
        });
    }
    return finalize(ctx);
}

/* ------------------------------------------------------------------ */
/* Dispatcher                                                           */
/* ------------------------------------------------------------------ */

export function parseSettlementCsv(
    source: SettlementSource,
    content: string,
    locale: ImportLocale = DEFAULT_LOCALE
): SettlementParseResult {
    switch (source) {
        case 'stripe':
            return parseStripeSettlementCsv(content, locale);
        case 'square':
            return parseSquareSettlementCsv(content, locale);
        case 'paypal':
            return parsePaypalSettlementCsv(content, locale);
        case 'shopify':
            return parseShopifySettlementCsv(content, locale);
    }
}
