/**
 * Business Reports — AR/AP aging, sales tax, business dashboard, Schedule C.
 *
 * Reads the NATIVE GnuCash business tables (invoices, entries, customers,
 * vendors, jobs, billterms, taxtables, lots) directly, following
 * GnuCash-desktop conventions:
 *
 *   - A posted invoice has `post_txn`, `post_acc`, and `post_lot` set.
 *   - owner_type: 2 = customer, 3 = job (resolve to the job's owner),
 *     4 = vendor, 5 = employee (ignored here).
 *   - AMOUNT-DUE SIGN CONVENTION (verified against the GnuCash SQL backend):
 *     posting a CUSTOMER INVOICE debits Accounts Receivable, so the A/R split
 *     that joins the invoice's lot has a POSITIVE value; payments credit A/R
 *     with NEGATIVE splits into the same lot. An unpaid customer invoice
 *     therefore has a POSITIVE lot balance, and `amountDue(ar) = +balance`.
 *     Posting a VENDOR BILL credits Accounts Payable, so the A/P lot split is
 *     NEGATIVE and payments are POSITIVE — an unpaid bill has a NEGATIVE lot
 *     balance, and `amountDue(ap) = -balance`. Credit notes flip signs
 *     naturally and show up as negative amounts due.
 *   - Due date = date_posted + billterms.duedays (via invoices.terms →
 *     billterms.guid), falling back to date_posted when no terms are set.
 *
 * Structure mirrors `src/lib/data-health.ts`: per-report SQL loaders plus
 * PURE aggregation logic (exported, unit-tested in
 * `src/lib/business/__tests__/business-reports.test.ts`).
 */

import prisma from '@/lib/prisma';

/* ------------------------------------------------------------------ */
/* Shared types                                                         */
/* ------------------------------------------------------------------ */

export type AgingSide = 'ar' | 'ap';

export const AGING_BUCKETS = ['current', 'b1_30', 'b31_60', 'b61_90', 'b90plus'] as const;
export type AgingBucketKey = (typeof AGING_BUCKETS)[number];

export const AGING_BUCKET_LABELS: Record<AgingBucketKey, string> = {
    current: 'Current',
    b1_30: '1–30',
    b31_60: '31–60',
    b61_90: '61–90',
    b90plus: '90+',
};

/** GncOwner type codes as stored in the SQL backend. */
export const OWNER_TYPE_CUSTOMER = 2;
export const OWNER_TYPE_JOB = 3;
export const OWNER_TYPE_VENDOR = 4;

/** Lot balances smaller than this are treated as fully paid. */
export const PAID_TOLERANCE = 0.005;

const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ */
/* Pure helpers — dates, signs, buckets                                 */
/* ------------------------------------------------------------------ */

/** Add whole days to a date (UTC-safe). */
export function addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * DAY_MS);
}

/** Whole days of (a - b), floored. Positive when `a` is after `b`. */
export function wholeDaysBetween(a: Date, b: Date): number {
    return Math.floor((a.getTime() - b.getTime()) / DAY_MS);
}

/**
 * Due date per GnuCash billterms: date_posted + duedays.
 * No terms (or proximo terms without duedays) fall back to the post date.
 */
export function computeDueDate(datePosted: Date, dueDays: number | null | undefined): Date {
    if (dueDays == null || !Number.isFinite(dueDays)) return datePosted;
    return addDays(datePosted, dueDays);
}

/**
 * Aging bucket for a number of days past due.
 * Boundary semantics: <=0 current, 1–30, 31–60, 61–90, >90 → 90+.
 * (Exactly 30/60/90 days past due land in the lower bucket.)
 */
export function bucketForDaysPastDue(daysPastDue: number): AgingBucketKey {
    if (daysPastDue <= 0) return 'current';
    if (daysPastDue <= 30) return 'b1_30';
    if (daysPastDue <= 60) return 'b31_60';
    if (daysPastDue <= 90) return 'b61_90';
    return 'b90plus';
}

/**
 * Convert a raw lot balance into an "amount due" for display.
 * See the sign-convention note in the module header:
 *   AR: unpaid invoice lots carry positive balances → amount due = +balance.
 *   AP: unpaid bill lots carry negative balances → amount due = -balance.
 */
export function amountDueFromLotBalance(lotBalance: number, side: AgingSide): number {
    return side === 'ar' ? lotBalance : -lotBalance;
}

export function emptyBuckets(): Record<AgingBucketKey, number> {
    return { current: 0, b1_30: 0, b31_60: 0, b61_90: 0, b90plus: 0 };
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Pure — AR/AP aging                                                   */
/* ------------------------------------------------------------------ */

/** Raw open-invoice row as produced by the SQL loader (DB-free for tests). */
export interface RawOpenInvoiceRow {
    guid: string;
    /** User-visible invoice/bill number (invoices.id). */
    id: string;
    ownerGuid: string;
    ownerName: string;
    datePosted: Date | string | null;
    /** billterms.duedays for the invoice's terms; null when no terms. */
    dueDays: number | null;
    /** Raw lot balance: sum of the post_lot's split values (sign-aware). */
    lotBalance: number;
    currency: string;
}

export interface AgingInvoice {
    guid: string;
    id: string;
    datePosted: string | null;
    dueDate: string | null;
    daysPastDue: number;
    amountDue: number;
    bucket: AgingBucketKey;
    currency: string;
}

export interface AgingOwnerRow {
    ownerGuid: string;
    ownerName: string;
    buckets: Record<AgingBucketKey, number>;
    total: number;
    invoices: AgingInvoice[];
}

export interface AgingReport {
    side: AgingSide;
    asOf: string;
    owners: AgingOwnerRow[];
    totals: Record<AgingBucketKey, number>;
    grandTotal: number;
    invoiceCount: number;
}

/**
 * Bucket open invoices/bills into an aging report grouped per owner.
 * Pure — takes loader rows plus a clock.
 */
export function buildAgingReport(
    rows: ReadonlyArray<RawOpenInvoiceRow>,
    side: AgingSide,
    asOf: Date = new Date(),
): AgingReport {
    const byOwner = new Map<string, AgingOwnerRow>();
    const totals = emptyBuckets();
    let grandTotal = 0;

    for (const row of rows) {
        const amountDue = amountDueFromLotBalance(row.lotBalance, side);
        const posted = row.datePosted ? new Date(row.datePosted) : null;
        const dueDate = posted ? computeDueDate(posted, row.dueDays) : null;
        const daysPastDue = dueDate ? wholeDaysBetween(asOf, dueDate) : 0;
        const bucket = bucketForDaysPastDue(daysPastDue);

        let owner = byOwner.get(row.ownerGuid);
        if (!owner) {
            owner = {
                ownerGuid: row.ownerGuid,
                ownerName: row.ownerName,
                buckets: emptyBuckets(),
                total: 0,
                invoices: [],
            };
            byOwner.set(row.ownerGuid, owner);
        }

        owner.buckets[bucket] = round2(owner.buckets[bucket] + amountDue);
        owner.total = round2(owner.total + amountDue);
        totals[bucket] = round2(totals[bucket] + amountDue);
        grandTotal = round2(grandTotal + amountDue);

        owner.invoices.push({
            guid: row.guid,
            id: row.id,
            datePosted: posted ? posted.toISOString().slice(0, 10) : null,
            dueDate: dueDate ? dueDate.toISOString().slice(0, 10) : null,
            daysPastDue,
            amountDue: round2(amountDue),
            bucket,
            currency: row.currency,
        });
    }

    const owners = [...byOwner.values()].sort((a, b) => b.total - a.total);
    for (const owner of owners) {
        owner.invoices.sort((a, b) => b.daysPastDue - a.daysPastDue);
    }

    return {
        side,
        asOf: asOf.toISOString(),
        owners,
        totals,
        grandTotal,
        invoiceCount: rows.length,
    };
}

/**
 * Sum of amounts due within the next `days` days (due date <= asOf + days).
 * Already-overdue items are INCLUDED — they are payable now. Pure.
 */
export function sumDueWithin(
    rows: ReadonlyArray<RawOpenInvoiceRow>,
    side: AgingSide,
    days: number,
    asOf: Date = new Date(),
): number {
    const cutoff = addDays(asOf, days).getTime();
    let sum = 0;
    for (const row of rows) {
        const posted = row.datePosted ? new Date(row.datePosted) : null;
        const due = posted ? computeDueDate(posted, row.dueDays) : asOf;
        if (due.getTime() <= cutoff) {
            sum += amountDueFromLotBalance(row.lotBalance, side);
        }
    }
    return round2(sum);
}

/* ------------------------------------------------------------------ */
/* Pure — days to pay                                                   */
/* ------------------------------------------------------------------ */

/** Whole days from invoice post date to payment date (floored, min 0). */
export function computeDaysToPay(postDate: Date | string, paymentDate: Date | string): number {
    return Math.max(0, wholeDaysBetween(new Date(paymentDate), new Date(postDate)));
}

/** Average of days-to-pay values, rounded to one decimal. Null when empty. */
export function averageDaysToPay(days: ReadonlyArray<number>): number | null {
    if (days.length === 0) return null;
    const sum = days.reduce((a, b) => a + b, 0);
    return Math.round((sum / days.length) * 10) / 10;
}

/* ------------------------------------------------------------------ */
/* Pure — sales tax                                                     */
/* ------------------------------------------------------------------ */

export interface RawTaxSplitRow {
    /** 'YYYY-MM' */
    month: string;
    accountGuid: string;
    accountName: string;
    /** Raw split-value sum. Tax collected posts as credits (negative). */
    amount: number;
}

export interface RawSalesRow {
    month: string;
    /** Raw income split-value sum (negative for revenue). */
    amount: number;
}

export interface TaxTableRateInfo {
    tableName: string;
    /** Percentage (e.g. 8.25) when rateType='percent'; flat amount otherwise. */
    rate: number;
    rateType: 'value' | 'percent';
}

export interface SalesTaxAccountSummary {
    accountGuid: string;
    accountName: string;
    /** Positive number: tax collected into this target account. */
    taxCollected: number;
    /** Tax tables that target this account (name + rate). */
    tables: TaxTableRateInfo[];
}

export interface SalesTaxMonthlyRow {
    month: string;
    taxableSales: number;
    taxCollected: number;
}

export interface SalesTaxReport {
    startDate: string;
    endDate: string;
    accounts: SalesTaxAccountSummary[];
    monthly: SalesTaxMonthlyRow[];
    totals: { taxableSales: number; taxCollected: number };
}

/** GncAmountType codes in taxtable_entries.type. */
export const TAXTABLE_AMT_TYPE_VALUE = 1;
export const TAXTABLE_AMT_TYPE_PERCENT = 2;

/**
 * Merge tax splits + invoiced sales into per-account and per-month summaries.
 * Pure. Signs are normalized here: tax collected and sales are credits
 * (negative raw sums) and are negated so the report reads positive.
 */
export function buildSalesTaxSummary(
    taxRows: ReadonlyArray<RawTaxSplitRow>,
    salesRows: ReadonlyArray<RawSalesRow>,
    ratesByAccount: ReadonlyMap<string, TaxTableRateInfo[]> = new Map(),
): Pick<SalesTaxReport, 'accounts' | 'monthly' | 'totals'> {
    const byAccount = new Map<string, SalesTaxAccountSummary>();
    const byMonth = new Map<string, SalesTaxMonthlyRow>();

    const monthRow = (month: string): SalesTaxMonthlyRow => {
        let row = byMonth.get(month);
        if (!row) {
            row = { month, taxableSales: 0, taxCollected: 0 };
            byMonth.set(month, row);
        }
        return row;
    };

    for (const row of taxRows) {
        const collected = -row.amount; // credit → positive collected
        let acct = byAccount.get(row.accountGuid);
        if (!acct) {
            acct = {
                accountGuid: row.accountGuid,
                accountName: row.accountName,
                taxCollected: 0,
                tables: ratesByAccount.get(row.accountGuid) ?? [],
            };
            byAccount.set(row.accountGuid, acct);
        }
        acct.taxCollected = round2(acct.taxCollected + collected);
        const m = monthRow(row.month);
        m.taxCollected = round2(m.taxCollected + collected);
    }

    for (const row of salesRows) {
        const sales = -row.amount; // income credit → positive sales
        const m = monthRow(row.month);
        m.taxableSales = round2(m.taxableSales + sales);
    }

    const monthly = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
    const accounts = [...byAccount.values()].sort((a, b) => b.taxCollected - a.taxCollected);
    const totals = {
        taxableSales: round2(monthly.reduce((s, m) => s + m.taxableSales, 0)),
        taxCollected: round2(monthly.reduce((s, m) => s + m.taxCollected, 0)),
    };

    return { accounts, monthly, totals };
}

/* ------------------------------------------------------------------ */
/* Pure — Schedule C mapping                                            */
/* ------------------------------------------------------------------ */

export interface ScheduleCRule {
    /** Schedule C line number, e.g. '8', '24a'. */
    line: string;
    pattern: RegExp;
}

/**
 * Keyword → Schedule C line rules. FIRST MATCH WINS, so more specific rules
 * come first (e.g. "Payroll Taxes" must hit line 23 before the wages rule,
 * and "Travel Meals" must hit meals before travel). Matched against the leaf
 * account name first, then the full account path — so an account under
 * "Expenses:Taxes" inherits the taxes line even with a generic leaf name.
 */
export const SCHEDULE_C_RULES: ReadonlyArray<ScheduleCRule> = [
    { line: '24b', pattern: /meal|dining|restaurant/i },
    { line: '24a', pattern: /travel|airfare|flight|lodging|hotel/i },
    // (?!i) keeps "Taxi" out of taxes-and-licenses.
    { line: '23', pattern: /tax(?!i)|licen[cs]e|permit/i },
    { line: '26', pattern: /wage|salar|payroll/i },
    { line: '8', pattern: /advertis|marketing|promotion/i },
    { line: '9', pattern: /\bcar\b|truck|vehicle|mileage|\bauto\b|fuel|gasoline|parking|toll/i },
    { line: '15', pattern: /insurance/i },
    { line: '17', pattern: /legal|attorney|lawyer|account(ing|ant)|bookkeep|\bcpa\b|professional fee/i },
    { line: '18', pattern: /office|postage|software|subscription/i },
    { line: '20', pattern: /\brent\b|rental|\blease\b/i },
    { line: '22', pattern: /supplie|supply|material/i },
    { line: '25', pattern: /utilit|electric|water|sewer|internet|phone|telephone|mobile|broadband/i },
];

export const SCHEDULE_C_LINE_LABELS: Record<string, string> = {
    '1': 'Gross receipts or sales',
    '8': 'Advertising',
    '9': 'Car and truck expenses',
    '15': 'Insurance (other than health)',
    '17': 'Legal and professional services',
    '18': 'Office expense',
    '20': 'Rent or lease',
    '22': 'Supplies',
    '23': 'Taxes and licenses',
    '24a': 'Travel',
    '24b': 'Deductible meals (50%)',
    '25': 'Utilities',
    '26': 'Wages',
    '27a': 'Other expenses',
};

/** Display order for expense lines on the report. */
export const SCHEDULE_C_EXPENSE_LINE_ORDER = [
    '8', '9', '15', '17', '18', '20', '22', '23', '24a', '24b', '25', '26', '27a',
] as const;

/**
 * Schedule C line numbers a MANUAL override may target: every labelled line
 * except '1' (gross receipts income). Equal to the expense line order set.
 */
export const SCHEDULE_C_MANUAL_LINES: ReadonlySet<string> = new Set(
    Object.keys(SCHEDULE_C_LINE_LABELS).filter((l) => l !== '1'),
);

/** True when `line` is a valid manual-override Schedule C expense line. */
export function isValidScheduleCLine(line: unknown): line is string {
    return typeof line === 'string' && SCHEDULE_C_MANUAL_LINES.has(line);
}

/**
 * Map an expense account to a Schedule C line via keyword rules.
 * Leaf name is checked first (most specific), then the full path (so
 * children inherit a parent category). Returns null when unmapped.
 */
export function mapExpenseAccountToLine(name: string, path: string): string | null {
    for (const rule of SCHEDULE_C_RULES) {
        if (rule.pattern.test(name)) return rule.line;
    }
    for (const rule of SCHEDULE_C_RULES) {
        if (rule.pattern.test(path)) return rule.line;
    }
    return null;
}

export interface ScheduleCAccountInput {
    guid: string;
    name: string;
    /** Full account path, e.g. "Expenses:Business:Meals". */
    path: string;
    type: 'INCOME' | 'EXPENSE';
    /** Raw split-value sum for the year (income negative, expenses positive). */
    total: number;
}

export interface ScheduleCAccountDetail {
    guid: string;
    name: string;
    path: string;
    amount: number;
    /** Keyword-heuristic line (null when no keyword matched). Income = '1'. */
    suggestedLine: string | null;
    /** Effective line this account landed on after applying manual overrides. */
    mappedLine: string;
}

export interface ScheduleCLine {
    line: string;
    label: string;
    /** Raw booked amount for this line. */
    amount: number;
    /** Deductible amount (== amount except meals at 50%). */
    deductible: number;
    accounts: ScheduleCAccountDetail[];
}

export interface ScheduleCReport {
    year: number;
    /** Line 1 — income totals, sign-corrected to read positive. */
    grossReceipts: number;
    incomeAccounts: ScheduleCAccountDetail[];
    /** Expense lines in SCHEDULE_C_EXPENSE_LINE_ORDER (zero lines included). */
    lines: ScheduleCLine[];
    /** Line 28 — total deductible expenses. */
    totalExpenses: number;
    /** Line 31 — net profit or (loss). */
    netProfit: number;
    /** Number of expense accounts that fell through to line 27a. */
    unmappedCount: number;
    /** Number of expense accounts whose line came from a manual override. */
    overriddenCount: number;
}

/**
 * Build a Schedule C estimate from the book's INCOME/EXPENSE totals for a
 * tax year. Pure. Meals (24b) are deducted at 50%; unmapped expenses land on
 * line 27a "Other expenses" with an itemized account list. This is an
 * ESTIMATE for sole-proprietor / single-member-LLC books, not filing advice.
 *
 * `overrides` maps an account GUID → a manual Schedule C line. A valid manual
 * override WINS over the keyword heuristic; unrecognized override lines are
 * ignored and fall back to the keyword result (then to line 27a). Omitting
 * `overrides` (default `{}`) preserves the original keyword-only behavior.
 */
export function buildScheduleC(
    year: number,
    accounts: ReadonlyArray<ScheduleCAccountInput>,
    overrides: Record<string, string> = {},
): ScheduleCReport {
    const incomeAccounts: ScheduleCAccountDetail[] = [];
    let grossReceipts = 0;

    const lineMap = new Map<string, ScheduleCLine>();
    for (const line of SCHEDULE_C_EXPENSE_LINE_ORDER) {
        lineMap.set(line, {
            line,
            label: SCHEDULE_C_LINE_LABELS[line],
            amount: 0,
            deductible: 0,
            accounts: [],
        });
    }

    let unmappedCount = 0;
    let overriddenCount = 0;

    for (const acct of accounts) {
        if (Math.abs(acct.total) < 0.005) continue;

        if (acct.type === 'INCOME') {
            // GnuCash stores income as credits (negative) — negate for display.
            const amount = round2(-acct.total);
            grossReceipts = round2(grossReceipts + amount);
            incomeAccounts.push({
                guid: acct.guid, name: acct.name, path: acct.path, amount,
                suggestedLine: '1', mappedLine: '1',
            });
            continue;
        }

        const suggested = mapExpenseAccountToLine(acct.name, acct.path);
        const override = overrides[acct.guid];
        const overridden = isValidScheduleCLine(override);
        const lineNo = overridden ? override : (suggested ?? '27a');
        if (overridden) overriddenCount++;
        else if (!suggested) unmappedCount++;

        const line = lineMap.get(lineNo)!;
        const amount = round2(acct.total);
        line.amount = round2(line.amount + amount);
        line.accounts.push({
            guid: acct.guid, name: acct.name, path: acct.path, amount,
            suggestedLine: suggested, mappedLine: lineNo,
        });
    }

    let totalExpenses = 0;
    for (const line of lineMap.values()) {
        line.deductible = line.line === '24b' ? round2(line.amount * 0.5) : line.amount;
        totalExpenses = round2(totalExpenses + line.deductible);
        line.accounts.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    }

    incomeAccounts.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

    return {
        year,
        grossReceipts,
        incomeAccounts,
        lines: SCHEDULE_C_EXPENSE_LINE_ORDER.map((l) => lineMap.get(l)!),
        totalExpenses,
        netProfit: round2(grossReceipts - totalExpenses),
        unmappedCount,
        overriddenCount,
    };
}

/* ------------------------------------------------------------------ */
/* Pure — period boundaries                                             */
/* ------------------------------------------------------------------ */

/** UTC starts of the current month, quarter, and year for `asOf`. */
export function periodStarts(asOf: Date): { monthStart: Date; quarterStart: Date; yearStart: Date } {
    const y = asOf.getUTCFullYear();
    const m = asOf.getUTCMonth();
    return {
        monthStart: new Date(Date.UTC(y, m, 1)),
        quarterStart: new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1)),
        yearStart: new Date(Date.UTC(y, 0, 1)),
    };
}

/* ------------------------------------------------------------------ */
/* SQL loaders                                                          */
/* ------------------------------------------------------------------ */

interface OpenInvoiceDbRow {
    guid: string;
    id: string;
    date_posted: Date | null;
    duedays: number | null;
    owner_guid: string | null;
    owner_name: string | null;
    currency: string | null;
    lot_balance: number;
}

/**
 * Open (posted, unpaid) invoices for one side of the house.
 * side 'ar' → customer invoices (owner_type 2, jobs resolved to their
 * customer); 'ap' → vendor bills (owner_type 4). Book-scoped via post_acc.
 */
export async function loadOpenInvoices(
    side: AgingSide,
    bookAccountGuids: string[],
): Promise<RawOpenInvoiceRow[]> {
    const ownerType = side === 'ar' ? OWNER_TYPE_CUSTOMER : OWNER_TYPE_VENDOR;

    const rows = await prisma.$queryRaw<OpenInvoiceDbRow[]>`
        WITH inv AS (
            SELECT
                i.guid, i.id, i.date_posted, i.currency, i.terms, i.post_lot,
                CASE WHEN i.owner_type = ${OWNER_TYPE_JOB} THEN j.owner_type ELSE i.owner_type END AS eff_owner_type,
                CASE WHEN i.owner_type = ${OWNER_TYPE_JOB} THEN j.owner_guid ELSE i.owner_guid END AS eff_owner_guid
            FROM invoices i
            LEFT JOIN jobs j ON i.owner_type = ${OWNER_TYPE_JOB} AND j.guid = i.owner_guid
            WHERE i.post_txn IS NOT NULL
              AND i.post_lot IS NOT NULL
              AND i.post_acc = ANY(${bookAccountGuids}::text[])
        )
        SELECT
            inv.guid,
            inv.id,
            inv.date_posted,
            bt.duedays,
            inv.eff_owner_guid AS owner_guid,
            COALESCE(cu.name, ve.name) AS owner_name,
            c.mnemonic AS currency,
            COALESCE(SUM(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric), 0)::float8 AS lot_balance
        FROM inv
        LEFT JOIN customers cu ON inv.eff_owner_type = ${OWNER_TYPE_CUSTOMER} AND cu.guid = inv.eff_owner_guid
        LEFT JOIN vendors ve ON inv.eff_owner_type = ${OWNER_TYPE_VENDOR} AND ve.guid = inv.eff_owner_guid
        LEFT JOIN billterms bt ON bt.guid = inv.terms
        LEFT JOIN commodities c ON c.guid = inv.currency
        LEFT JOIN splits s ON s.lot_guid = inv.post_lot
        WHERE inv.eff_owner_type = ${ownerType}
        GROUP BY inv.guid, inv.id, inv.date_posted, bt.duedays, inv.eff_owner_guid, cu.name, ve.name, c.mnemonic
        HAVING ABS(COALESCE(SUM(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric), 0)) > ${PAID_TOLERANCE}
    `;

    return rows.map((r) => ({
        guid: r.guid,
        id: r.id,
        ownerGuid: r.owner_guid ?? '(none)',
        ownerName: r.owner_name ?? '(unknown)',
        datePosted: r.date_posted,
        dueDays: r.duedays,
        lotBalance: r.lot_balance,
        currency: r.currency ?? 'USD',
    }));
}

/** Full AR or AP aging report for the active book. */
export async function generateAgingReport(
    side: AgingSide,
    bookAccountGuids: string[],
    asOf: Date = new Date(),
): Promise<AgingReport> {
    const rows = await loadOpenInvoices(side, bookAccountGuids);
    return buildAgingReport(rows, side, asOf);
}

/* ---------------------------- Sales tax ---------------------------- */

/**
 * Sales tax collected for a date range, from posted CUSTOMER invoice
 * transactions' splits landing in tax-table target accounts, plus invoiced
 * sales (income splits on the same transactions) for the filing summary.
 *
 * Note: "taxable sales" here is approximated as ALL invoiced income in the
 * range — per-entry i_taxable flags are not consulted.
 */
export async function generateSalesTaxReport(
    startDate: string,
    endDate: string,
    bookAccountGuids: string[],
): Promise<SalesTaxReport> {
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T23:59:59.999Z`);

    const taxRows = await prisma.$queryRaw<
        { month: string; account_guid: string; account_name: string; amount: number }[]
    >`
        WITH inv AS (
            SELECT i.post_txn
            FROM invoices i
            LEFT JOIN jobs j ON i.owner_type = ${OWNER_TYPE_JOB} AND j.guid = i.owner_guid
            WHERE i.post_txn IS NOT NULL
              AND i.post_acc = ANY(${bookAccountGuids}::text[])
              AND (CASE WHEN i.owner_type = ${OWNER_TYPE_JOB} THEN j.owner_type ELSE i.owner_type END) = ${OWNER_TYPE_CUSTOMER}
        )
        SELECT
            to_char(t.post_date, 'YYYY-MM') AS month,
            s.account_guid,
            a.name AS account_name,
            SUM(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric)::float8 AS amount
        FROM inv
        JOIN transactions t ON t.guid = inv.post_txn
        JOIN splits s ON s.tx_guid = t.guid
        JOIN accounts a ON a.guid = s.account_guid
        WHERE t.post_date >= ${start} AND t.post_date <= ${end}
          AND s.account_guid IN (SELECT DISTINCT account FROM taxtable_entries)
        GROUP BY 1, 2, 3
    `;

    const salesRows = await prisma.$queryRaw<{ month: string; amount: number }[]>`
        WITH inv AS (
            SELECT i.post_txn
            FROM invoices i
            LEFT JOIN jobs j ON i.owner_type = ${OWNER_TYPE_JOB} AND j.guid = i.owner_guid
            WHERE i.post_txn IS NOT NULL
              AND i.post_acc = ANY(${bookAccountGuids}::text[])
              AND (CASE WHEN i.owner_type = ${OWNER_TYPE_JOB} THEN j.owner_type ELSE i.owner_type END) = ${OWNER_TYPE_CUSTOMER}
        )
        SELECT
            to_char(t.post_date, 'YYYY-MM') AS month,
            SUM(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric)::float8 AS amount
        FROM inv
        JOIN transactions t ON t.guid = inv.post_txn
        JOIN splits s ON s.tx_guid = t.guid
        JOIN accounts a ON a.guid = s.account_guid
        WHERE t.post_date >= ${start} AND t.post_date <= ${end}
          AND a.account_type = 'INCOME'
        GROUP BY 1
    `;

    const rateRows = await prisma.$queryRaw<
        { account: string; table_name: string; amount_num: bigint; amount_denom: bigint; type: number }[]
    >`
        SELECT tte.account, tt.name AS table_name, tte.amount_num, tte.amount_denom, tte.type
        FROM taxtable_entries tte
        JOIN taxtables tt ON tt.guid = tte.taxtable
    `;

    const ratesByAccount = new Map<string, TaxTableRateInfo[]>();
    for (const r of rateRows) {
        const list = ratesByAccount.get(r.account) ?? [];
        const denom = Number(r.amount_denom);
        list.push({
            tableName: r.table_name,
            rate: denom !== 0 ? Number(r.amount_num) / denom : 0,
            rateType: r.type === TAXTABLE_AMT_TYPE_PERCENT ? 'percent' : 'value',
        });
        ratesByAccount.set(r.account, list);
    }

    const summary = buildSalesTaxSummary(
        taxRows.map((r) => ({
            month: r.month,
            accountGuid: r.account_guid,
            accountName: r.account_name,
            amount: r.amount,
        })),
        salesRows.map((r) => ({ month: r.month, amount: r.amount })),
        ratesByAccount,
    );

    return { startDate, endDate, ...summary };
}

/* ---------------------------- Dashboard ---------------------------- */

export interface TopCustomerRow {
    guid: string;
    name: string;
    revenue: number;
    invoiceCount: number;
}

export interface RecentInvoiceRow {
    guid: string;
    id: string;
    type: 'invoice' | 'bill';
    ownerName: string;
    datePosted: string | null;
    /** Posted total, sign-normalized to read positive. */
    total: number;
    /** Remaining amount due (0 when fully paid). */
    amountDue: number;
    currency: string;
}

export interface BusinessDashboard {
    asOf: string;
    revenue: { month: number; quarter: number; ytd: number };
    ar: {
        total: number;
        count: number;
        buckets: Record<AgingBucketKey, number>;
    };
    ap: {
        total: number;
        count: number;
        buckets: Record<AgingBucketKey, number>;
        dueWithin7: number;
        dueWithin30: number;
    };
    topCustomers: TopCustomerRow[];
    recentInvoices: RecentInvoiceRow[];
    /** Average days from post to final payment across paid customer invoices. */
    avgDaysToPay: number | null;
    paidInvoiceCount: number;
}

export async function generateBusinessDashboard(
    bookAccountGuids: string[],
    asOf: Date = new Date(),
): Promise<BusinessDashboard> {
    const { monthStart, quarterStart, yearStart } = periodStarts(asOf);

    const [revenueRows, arRows, apRows, topCustomers, recentRows, paidRows] = await Promise.all([
        prisma.$queryRaw<{ month: number | null; quarter: number | null; ytd: number | null }[]>`
            SELECT
                (SUM(-s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric)
                    FILTER (WHERE t.post_date >= ${monthStart}))::float8 AS month,
                (SUM(-s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric)
                    FILTER (WHERE t.post_date >= ${quarterStart}))::float8 AS quarter,
                (SUM(-s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric)
                    FILTER (WHERE t.post_date >= ${yearStart}))::float8 AS ytd
            FROM splits s
            JOIN transactions t ON t.guid = s.tx_guid
            JOIN accounts a ON a.guid = s.account_guid
            WHERE a.account_type = 'INCOME'
              AND a.guid = ANY(${bookAccountGuids}::text[])
              AND t.post_date <= ${asOf}
        `,
        loadOpenInvoices('ar', bookAccountGuids),
        loadOpenInvoices('ap', bookAccountGuids),
        prisma.$queryRaw<{ guid: string; name: string; revenue: number; invoice_count: number }[]>`
            WITH inv AS (
                SELECT
                    i.guid, i.post_txn, i.post_acc,
                    CASE WHEN i.owner_type = ${OWNER_TYPE_JOB} THEN j.owner_guid ELSE i.owner_guid END AS eff_owner_guid,
                    CASE WHEN i.owner_type = ${OWNER_TYPE_JOB} THEN j.owner_type ELSE i.owner_type END AS eff_owner_type
                FROM invoices i
                LEFT JOIN jobs j ON i.owner_type = ${OWNER_TYPE_JOB} AND j.guid = i.owner_guid
                WHERE i.post_txn IS NOT NULL
                  AND i.post_acc = ANY(${bookAccountGuids}::text[])
            )
            SELECT
                cu.guid,
                cu.name,
                SUM(ps.value_num::numeric / NULLIF(ps.value_denom, 0)::numeric)::float8 AS revenue,
                COUNT(DISTINCT inv.guid)::int AS invoice_count
            FROM inv
            JOIN customers cu ON cu.guid = inv.eff_owner_guid
            JOIN transactions t ON t.guid = inv.post_txn
            JOIN splits ps ON ps.tx_guid = inv.post_txn AND ps.account_guid = inv.post_acc
            WHERE inv.eff_owner_type = ${OWNER_TYPE_CUSTOMER}
              AND t.post_date >= ${yearStart} AND t.post_date <= ${asOf}
            GROUP BY cu.guid, cu.name
            ORDER BY revenue DESC
            LIMIT 5
        `,
        prisma.$queryRaw<
            {
                guid: string;
                id: string;
                eff_owner_type: number;
                owner_name: string | null;
                date_posted: Date | null;
                currency: string | null;
                total: number;
                balance: number;
            }[]
        >`
            WITH inv AS (
                SELECT
                    i.guid, i.id, i.date_posted, i.currency, i.post_txn, i.post_acc, i.post_lot,
                    CASE WHEN i.owner_type = ${OWNER_TYPE_JOB} THEN j.owner_guid ELSE i.owner_guid END AS eff_owner_guid,
                    CASE WHEN i.owner_type = ${OWNER_TYPE_JOB} THEN j.owner_type ELSE i.owner_type END AS eff_owner_type
                FROM invoices i
                LEFT JOIN jobs j ON i.owner_type = ${OWNER_TYPE_JOB} AND j.guid = i.owner_guid
                WHERE i.post_txn IS NOT NULL
                  AND i.post_acc = ANY(${bookAccountGuids}::text[])
            )
            SELECT
                inv.guid,
                inv.id,
                inv.eff_owner_type,
                COALESCE(cu.name, ve.name) AS owner_name,
                inv.date_posted,
                c.mnemonic AS currency,
                COALESCE((
                    SELECT SUM(ps.value_num::numeric / NULLIF(ps.value_denom, 0)::numeric)
                    FROM splits ps
                    WHERE ps.tx_guid = inv.post_txn AND ps.account_guid = inv.post_acc
                ), 0)::float8 AS total,
                COALESCE((
                    SELECT SUM(ls.value_num::numeric / NULLIF(ls.value_denom, 0)::numeric)
                    FROM splits ls
                    WHERE ls.lot_guid = inv.post_lot
                ), 0)::float8 AS balance
            FROM inv
            LEFT JOIN customers cu ON inv.eff_owner_type = ${OWNER_TYPE_CUSTOMER} AND cu.guid = inv.eff_owner_guid
            LEFT JOIN vendors ve ON inv.eff_owner_type = ${OWNER_TYPE_VENDOR} AND ve.guid = inv.eff_owner_guid
            LEFT JOIN commodities c ON c.guid = inv.currency
            WHERE inv.eff_owner_type IN (${OWNER_TYPE_CUSTOMER}, ${OWNER_TYPE_VENDOR})
            ORDER BY inv.date_posted DESC NULLS LAST
            LIMIT 8
        `,
        prisma.$queryRaw<{ guid: string; date_posted: Date | null; paid_date: Date | null; balance: number }[]>`
            WITH inv AS (
                SELECT
                    i.guid, i.date_posted, i.post_txn, i.post_lot,
                    CASE WHEN i.owner_type = ${OWNER_TYPE_JOB} THEN j.owner_type ELSE i.owner_type END AS eff_owner_type
                FROM invoices i
                LEFT JOIN jobs j ON i.owner_type = ${OWNER_TYPE_JOB} AND j.guid = i.owner_guid
                WHERE i.post_txn IS NOT NULL
                  AND i.post_lot IS NOT NULL
                  AND i.date_posted IS NOT NULL
                  AND i.post_acc = ANY(${bookAccountGuids}::text[])
            )
            SELECT
                inv.guid,
                inv.date_posted,
                (
                    SELECT MAX(t2.post_date)
                    FROM splits ls
                    JOIN transactions t2 ON t2.guid = ls.tx_guid
                    WHERE ls.lot_guid = inv.post_lot AND ls.tx_guid <> inv.post_txn
                ) AS paid_date,
                COALESCE((
                    SELECT SUM(ls.value_num::numeric / NULLIF(ls.value_denom, 0)::numeric)
                    FROM splits ls
                    WHERE ls.lot_guid = inv.post_lot
                ), 0)::float8 AS balance
            FROM inv
            WHERE inv.eff_owner_type = ${OWNER_TYPE_CUSTOMER}
        `,
    ]);

    const revenue = revenueRows[0] ?? { month: 0, quarter: 0, ytd: 0 };
    const arAging = buildAgingReport(arRows, 'ar', asOf);
    const apAging = buildAgingReport(apRows, 'ap', asOf);

    const daysToPay: number[] = [];
    for (const row of paidRows) {
        if (Math.abs(row.balance) >= PAID_TOLERANCE) continue; // still open
        if (!row.paid_date || !row.date_posted) continue;
        daysToPay.push(computeDaysToPay(row.date_posted, row.paid_date));
    }

    const recentInvoices: RecentInvoiceRow[] = recentRows.map((r) => {
        const isBill = r.eff_owner_type === OWNER_TYPE_VENDOR;
        const side: AgingSide = isBill ? 'ap' : 'ar';
        return {
            guid: r.guid,
            id: r.id,
            type: isBill ? 'bill' : 'invoice',
            ownerName: r.owner_name ?? '(unknown)',
            datePosted: r.date_posted ? r.date_posted.toISOString().slice(0, 10) : null,
            total: round2(amountDueFromLotBalance(r.total, side)),
            amountDue: round2(amountDueFromLotBalance(r.balance, side)),
            currency: r.currency ?? 'USD',
        };
    });

    return {
        asOf: asOf.toISOString(),
        revenue: {
            month: round2(revenue.month ?? 0),
            quarter: round2(revenue.quarter ?? 0),
            ytd: round2(revenue.ytd ?? 0),
        },
        ar: {
            total: arAging.grandTotal,
            count: arAging.invoiceCount,
            buckets: arAging.totals,
        },
        ap: {
            total: apAging.grandTotal,
            count: apAging.invoiceCount,
            buckets: apAging.totals,
            dueWithin7: sumDueWithin(apRows, 'ap', 7, asOf),
            dueWithin30: sumDueWithin(apRows, 'ap', 30, asOf),
        },
        topCustomers: topCustomers.map((c) => ({
            guid: c.guid,
            name: c.name,
            revenue: round2(c.revenue),
            invoiceCount: c.invoice_count,
        })),
        recentInvoices,
        avgDaysToPay: averageDaysToPay(daysToPay),
        paidInvoiceCount: daysToPay.length,
    };
}

/* ---------------------------- Schedule C --------------------------- */

/**
 * Schedule C estimate for a tax year: sums the book's INCOME/EXPENSE splits
 * per account and maps them onto Schedule C lines via keyword rules.
 * Intended for sole-proprietor / single-member-LLC books.
 */
export async function generateScheduleC(
    bookAccountGuids: string[],
    year: number,
    overrides: Record<string, string> = {},
): Promise<ScheduleCReport> {
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));

    const rows = await prisma.$queryRaw<
        { guid: string; name: string; fullname: string; account_type: string; total: number }[]
    >`
        SELECT
            ah.guid,
            ah.name,
            ah.fullname,
            ah.account_type,
            SUM(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric)::float8 AS total
        FROM account_hierarchy ah
        JOIN splits s ON s.account_guid = ah.guid
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE ah.guid = ANY(${bookAccountGuids}::text[])
          AND ah.account_type IN ('INCOME', 'EXPENSE')
          AND t.post_date >= ${start} AND t.post_date <= ${end}
        GROUP BY ah.guid, ah.name, ah.fullname, ah.account_type
    `;

    return buildScheduleC(
        year,
        rows.map((r) => ({
            guid: r.guid,
            name: r.name,
            path: r.fullname,
            type: r.account_type as 'INCOME' | 'EXPENSE',
            total: r.total,
        })),
        overrides,
    );
}
