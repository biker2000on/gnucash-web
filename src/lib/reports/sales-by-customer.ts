import prisma from '@/lib/prisma';
import {
    OWNER_TYPE_CUSTOMER,
    OWNER_TYPE_JOB,
} from '@/lib/business/business-reports';
import { ReportType, ReportData, ReportFilters, ReportSection } from './types';

/**
 * Sales by Customer — per-customer totals from POSTED customer invoices.
 *
 * Conventions follow src/lib/business/business-reports.ts:
 *   - A posted invoice has `post_txn` (and normally `post_lot`) set;
 *     book-scoped via `post_acc`.
 *   - owner_type 2 = customer; owner_type 3 = job, resolved to the job's
 *     owner (kept only when that owner is a customer).
 *   - AMOUNT SOURCE: amounts are read from the POSTING TRANSACTION's splits,
 *     not from invoice entries. The invoice TOTAL is the sum of the A/R
 *     splits (`post_txn` splits landing in `post_acc`) — positive for
 *     invoices, negative for credit notes. TAX is the sum of `post_txn`
 *     splits landing in tax-table target accounts (credits, negated to read
 *     positive). SUBTOTAL = total − tax.
 *   - PAYMENTS: the invoice's `post_lot` balance is the amount still owed
 *     (positive for A/R); payments received = total − lot balance.
 *   - Date filtering uses `invoices.date_posted` (inclusive day range).
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** One posted invoice as produced by the SQL loader (DB-free for tests). */
export interface RawPostedInvoiceRow {
    guid: string;
    /** Raw invoices.owner_type (2 = customer, 3 = job). */
    ownerType: number;
    ownerGuid: string | null;
    /** Sum of post_txn splits at post_acc (A/R): invoice total, tax included. */
    postedTotal: number;
    /** Sum of post_txn splits in tax-table target accounts (credits ≤ 0). */
    taxTotal: number;
    /** Raw post_lot balance (positive = still owed for A/R). */
    lotBalance: number;
    currency: string;
}

/** jobs.guid → the job's owner (owner_type 2 when customer-owned). */
export interface JobOwnerRef {
    ownerType: number;
    ownerGuid: string | null;
}

export interface CustomerSalesRow {
    customerGuid: string;
    customerName: string;
    invoiceCount: number;
    /** Total net of tax */
    subtotal: number;
    tax: number;
    /** Posted invoice total (tax included) */
    total: number;
    /** total − outstanding balance */
    payments: number;
    /** Amount still owed */
    balance: number;
}

export interface SalesByCustomerTotals {
    invoiceCount: number;
    subtotal: number;
    tax: number;
    total: number;
    payments: number;
    balance: number;
}

export interface SalesByCustomerData extends ReportData {
    startDate: string;
    endDate: string;
    currency: string;
    customers: CustomerSalesRow[];
    totals: SalesByCustomerTotals;
}

/* ------------------------------------------------------------------ */
/* Pure aggregation (exported for unit tests)                          */
/* ------------------------------------------------------------------ */

const round2 = (n: number): number => {
    const r = Math.round(n * 100) / 100;
    return r === 0 ? 0 : r;
};

/**
 * Resolve an invoice's effective customer: direct customer owners pass
 * through; job owners resolve to the job's owner. Returns null when the
 * effective owner is not a customer (e.g. vendor-owned job) or unknown.
 */
export function resolveCustomerGuid(
    ownerType: number,
    ownerGuid: string | null,
    jobOwners: ReadonlyMap<string, JobOwnerRef>,
): string | null {
    if (ownerType === OWNER_TYPE_CUSTOMER) return ownerGuid;
    if (ownerType === OWNER_TYPE_JOB && ownerGuid) {
        const job = jobOwners.get(ownerGuid);
        if (job && job.ownerType === OWNER_TYPE_CUSTOMER) return job.ownerGuid;
    }
    return null;
}

/**
 * Roll posted customer invoices up per customer. Pure.
 * Rows whose effective owner is not a customer are skipped. Sorted by total
 * descending (name as tiebreak).
 */
export function buildSalesByCustomer(
    rows: ReadonlyArray<RawPostedInvoiceRow>,
    jobOwners: ReadonlyMap<string, JobOwnerRef>,
    customerNames: ReadonlyMap<string, string>,
): { customers: CustomerSalesRow[]; totals: SalesByCustomerTotals } {
    const byCustomer = new Map<string, CustomerSalesRow>();

    for (const row of rows) {
        const customerGuid = resolveCustomerGuid(row.ownerType, row.ownerGuid, jobOwners);
        if (!customerGuid) continue;

        const total = row.postedTotal;
        const tax = -row.taxTotal; // tax splits are credits → negate to read positive
        const balance = row.lotBalance;
        const payments = total - balance;

        let customer = byCustomer.get(customerGuid);
        if (!customer) {
            customer = {
                customerGuid,
                customerName: customerNames.get(customerGuid) ?? '(unknown)',
                invoiceCount: 0,
                subtotal: 0,
                tax: 0,
                total: 0,
                payments: 0,
                balance: 0,
            };
            byCustomer.set(customerGuid, customer);
        }

        customer.invoiceCount += 1;
        customer.subtotal = round2(customer.subtotal + (total - tax));
        customer.tax = round2(customer.tax + tax);
        customer.total = round2(customer.total + total);
        customer.payments = round2(customer.payments + payments);
        customer.balance = round2(customer.balance + balance);
    }

    const customers = [...byCustomer.values()].sort(
        (a, b) => b.total - a.total || a.customerName.localeCompare(b.customerName)
    );

    const totals: SalesByCustomerTotals = {
        invoiceCount: customers.reduce((s, c) => s + c.invoiceCount, 0),
        subtotal: round2(customers.reduce((s, c) => s + c.subtotal, 0)),
        tax: round2(customers.reduce((s, c) => s + c.tax, 0)),
        total: round2(customers.reduce((s, c) => s + c.total, 0)),
        payments: round2(customers.reduce((s, c) => s + c.payments, 0)),
        balance: round2(customers.reduce((s, c) => s + c.balance, 0)),
    };

    return { customers, totals };
}

/**
 * ReportData-compatible sections projection so the generic single-amount CSV
 * export works: one section, item amount = invoice TOTAL per customer.
 */
export function buildSalesSections(
    customers: CustomerSalesRow[],
    totals: SalesByCustomerTotals,
): ReportSection[] {
    return [{
        title: 'Sales by Customer',
        items: customers.map(c => ({ guid: c.customerGuid, name: c.customerName, amount: c.total })),
        total: totals.total,
    }];
}

/* ------------------------------------------------------------------ */
/* DB-bound generator                                                  */
/* ------------------------------------------------------------------ */

/** Most frequent currency across rows; USD when empty. */
export function dominantCurrency(rows: ReadonlyArray<{ currency: string }>): string {
    const freq = new Map<string, number>();
    for (const row of rows) {
        freq.set(row.currency, (freq.get(row.currency) || 0) + 1);
    }
    return [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'USD';
}

interface PostedInvoiceDbRow {
    guid: string;
    owner_type: number;
    owner_guid: string | null;
    currency: string | null;
    posted_total: number;
    tax_total: number;
    lot_balance: number;
}

/** Generate the Sales by Customer report for the date range in `filters`. */
export async function generateSalesByCustomer(filters: ReportFilters): Promise<SalesByCustomerData> {
    const now = new Date();
    const startDate = filters.startDate ?? `${now.getUTCFullYear()}-01-01`;
    const endDate = filters.endDate ?? now.toISOString().split('T')[0];
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T23:59:59.999Z`);
    const bookAccountGuids = filters.bookAccountGuids ?? [];

    const [invoiceRows, jobRows, customerRows] = await Promise.all([
        prisma.$queryRaw<PostedInvoiceDbRow[]>`
            SELECT
                i.guid,
                i.owner_type,
                i.owner_guid,
                c.mnemonic AS currency,
                COALESCE((
                    SELECT SUM(ps.value_num::numeric / NULLIF(ps.value_denom, 0)::numeric)
                    FROM splits ps
                    WHERE ps.tx_guid = i.post_txn AND ps.account_guid = i.post_acc
                ), 0)::float8 AS posted_total,
                COALESCE((
                    SELECT SUM(ts.value_num::numeric / NULLIF(ts.value_denom, 0)::numeric)
                    FROM splits ts
                    WHERE ts.tx_guid = i.post_txn
                      AND ts.account_guid IN (SELECT DISTINCT account FROM taxtable_entries)
                ), 0)::float8 AS tax_total,
                COALESCE((
                    SELECT SUM(ls.value_num::numeric / NULLIF(ls.value_denom, 0)::numeric)
                    FROM splits ls
                    WHERE ls.lot_guid = i.post_lot
                ), 0)::float8 AS lot_balance
            FROM invoices i
            LEFT JOIN commodities c ON c.guid = i.currency
            WHERE i.post_txn IS NOT NULL
              AND i.post_acc = ANY(${bookAccountGuids}::text[])
              AND i.owner_type IN (${OWNER_TYPE_CUSTOMER}, ${OWNER_TYPE_JOB})
              AND i.date_posted >= ${start} AND i.date_posted <= ${end}
        `,
        prisma.$queryRaw<{ guid: string; owner_type: number; owner_guid: string | null }[]>`
            SELECT guid, owner_type, owner_guid FROM jobs
        `,
        prisma.$queryRaw<{ guid: string; name: string }[]>`
            SELECT guid, name FROM customers
        `,
    ]);

    const rows: RawPostedInvoiceRow[] = invoiceRows.map(r => ({
        guid: r.guid,
        ownerType: r.owner_type,
        ownerGuid: r.owner_guid,
        postedTotal: r.posted_total,
        taxTotal: r.tax_total,
        lotBalance: r.lot_balance,
        currency: r.currency ?? 'USD',
    }));

    const jobOwners = new Map<string, JobOwnerRef>(
        jobRows.map(j => [j.guid, { ownerType: j.owner_type, ownerGuid: j.owner_guid }])
    );
    const customerNames = new Map(customerRows.map(c => [c.guid, c.name]));

    const { customers, totals } = buildSalesByCustomer(rows, jobOwners, customerNames);

    return {
        type: ReportType.SALES_BY_CUSTOMER,
        title: 'Sales by Customer',
        generatedAt: new Date().toISOString(),
        filters,
        startDate,
        endDate,
        currency: dominantCurrency(rows),
        customers,
        totals,
        sections: buildSalesSections(customers, totals),
        grandTotal: totals.total,
    };
}
