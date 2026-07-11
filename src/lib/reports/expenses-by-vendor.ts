import prisma from '@/lib/prisma';
import {
    OWNER_TYPE_JOB,
    OWNER_TYPE_VENDOR,
} from '@/lib/business/business-reports';
import { ReportType, ReportData, ReportFilters, ReportSection } from './types';
import { dominantCurrency, JobOwnerRef } from './sales-by-customer';

/**
 * Expenses by Vendor — per-vendor totals from POSTED vendor bills.
 *
 * Conventions follow src/lib/business/business-reports.ts:
 *   - A posted bill has `post_txn` (and normally `post_lot`) set; book-scoped
 *     via `post_acc`.
 *   - owner_type 4 = vendor; owner_type 3 = job, resolved to the job's owner
 *     (kept only when that owner is a vendor).
 *   - AMOUNT SOURCE + SIGNS: amounts come from the POSTING TRANSACTION's
 *     splits. Posting a vendor bill CREDITS Accounts Payable, so the A/P
 *     split sum (`post_txn` splits at `post_acc`) is NEGATIVE — TOTAL BILLED
 *     is its negation (credit notes flip to negative billed). The `post_lot`
 *     balance is likewise negative while unpaid, so BALANCE (still owed)
 *     = −lot balance and PAID = total billed − balance.
 *   - Ledger expense splits from bill-posting transactions are NOT summed
 *     separately — the A/P side already equals expenses + tax per bill.
 *   - Date filtering uses `invoices.date_posted` (inclusive day range).
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** One posted bill as produced by the SQL loader (DB-free for tests). */
export interface RawPostedBillRow {
    guid: string;
    /** Raw invoices.owner_type (4 = vendor, 3 = job). */
    ownerType: number;
    ownerGuid: string | null;
    /** Sum of post_txn splits at post_acc (A/P): NEGATIVE for a bill. */
    postedTotal: number;
    /** Raw post_lot balance (NEGATIVE = still owed for A/P). */
    lotBalance: number;
    currency: string;
}

export interface VendorExpenseRow {
    vendorGuid: string;
    vendorName: string;
    billCount: number;
    /** Positive = amount billed by the vendor (tax included) */
    totalBilled: number;
    /** totalBilled − balance */
    paid: number;
    /** Amount still owed to the vendor */
    balance: number;
}

export interface ExpensesByVendorTotals {
    billCount: number;
    totalBilled: number;
    paid: number;
    balance: number;
}

export interface ExpensesByVendorData extends ReportData {
    startDate: string;
    endDate: string;
    currency: string;
    vendors: VendorExpenseRow[];
    totals: ExpensesByVendorTotals;
}

/* ------------------------------------------------------------------ */
/* Pure aggregation (exported for unit tests)                          */
/* ------------------------------------------------------------------ */

const round2 = (n: number): number => {
    const r = Math.round(n * 100) / 100;
    return r === 0 ? 0 : r;
};

/**
 * Resolve a bill's effective vendor: direct vendor owners pass through; job
 * owners resolve to the job's owner. Returns null when the effective owner
 * is not a vendor (e.g. customer-owned job) or unknown.
 */
export function resolveVendorGuid(
    ownerType: number,
    ownerGuid: string | null,
    jobOwners: ReadonlyMap<string, JobOwnerRef>,
): string | null {
    if (ownerType === OWNER_TYPE_VENDOR) return ownerGuid;
    if (ownerType === OWNER_TYPE_JOB && ownerGuid) {
        const job = jobOwners.get(ownerGuid);
        if (job && job.ownerType === OWNER_TYPE_VENDOR) return job.ownerGuid;
    }
    return null;
}

/**
 * Roll posted vendor bills up per vendor. Pure.
 * A/P signs are normalized here (see module header). Rows whose effective
 * owner is not a vendor are skipped. Sorted by total billed descending
 * (name as tiebreak).
 */
export function buildExpensesByVendor(
    rows: ReadonlyArray<RawPostedBillRow>,
    jobOwners: ReadonlyMap<string, JobOwnerRef>,
    vendorNames: ReadonlyMap<string, string>,
): { vendors: VendorExpenseRow[]; totals: ExpensesByVendorTotals } {
    const byVendor = new Map<string, VendorExpenseRow>();

    for (const row of rows) {
        const vendorGuid = resolveVendorGuid(row.ownerType, row.ownerGuid, jobOwners);
        if (!vendorGuid) continue;

        // A/P convention: bill posts as a credit → negate to read positive.
        const totalBilled = -row.postedTotal;
        const balance = -row.lotBalance;
        const paid = totalBilled - balance;

        let vendor = byVendor.get(vendorGuid);
        if (!vendor) {
            vendor = {
                vendorGuid,
                vendorName: vendorNames.get(vendorGuid) ?? '(unknown)',
                billCount: 0,
                totalBilled: 0,
                paid: 0,
                balance: 0,
            };
            byVendor.set(vendorGuid, vendor);
        }

        vendor.billCount += 1;
        vendor.totalBilled = round2(vendor.totalBilled + totalBilled);
        vendor.paid = round2(vendor.paid + paid);
        vendor.balance = round2(vendor.balance + balance);
    }

    const vendors = [...byVendor.values()].sort(
        (a, b) => b.totalBilled - a.totalBilled || a.vendorName.localeCompare(b.vendorName)
    );

    const totals: ExpensesByVendorTotals = {
        billCount: vendors.reduce((s, v) => s + v.billCount, 0),
        totalBilled: round2(vendors.reduce((s, v) => s + v.totalBilled, 0)),
        paid: round2(vendors.reduce((s, v) => s + v.paid, 0)),
        balance: round2(vendors.reduce((s, v) => s + v.balance, 0)),
    };

    return { vendors, totals };
}

/**
 * ReportData-compatible sections projection so the generic single-amount CSV
 * export works: one section, item amount = TOTAL BILLED per vendor.
 */
export function buildVendorSections(
    vendors: VendorExpenseRow[],
    totals: ExpensesByVendorTotals,
): ReportSection[] {
    return [{
        title: 'Expenses by Vendor',
        items: vendors.map(v => ({ guid: v.vendorGuid, name: v.vendorName, amount: v.totalBilled })),
        total: totals.totalBilled,
    }];
}

/* ------------------------------------------------------------------ */
/* DB-bound generator                                                  */
/* ------------------------------------------------------------------ */

interface PostedBillDbRow {
    guid: string;
    owner_type: number;
    owner_guid: string | null;
    currency: string | null;
    posted_total: number;
    lot_balance: number;
}

/** Generate the Expenses by Vendor report for the date range in `filters`. */
export async function generateExpensesByVendor(filters: ReportFilters): Promise<ExpensesByVendorData> {
    const now = new Date();
    const startDate = filters.startDate ?? `${now.getUTCFullYear()}-01-01`;
    const endDate = filters.endDate ?? now.toISOString().split('T')[0];
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T23:59:59.999Z`);
    const bookAccountGuids = filters.bookAccountGuids ?? [];

    const [billRows, jobRows, vendorRows] = await Promise.all([
        prisma.$queryRaw<PostedBillDbRow[]>`
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
                    SELECT SUM(ls.value_num::numeric / NULLIF(ls.value_denom, 0)::numeric)
                    FROM splits ls
                    WHERE ls.lot_guid = i.post_lot
                ), 0)::float8 AS lot_balance
            FROM invoices i
            LEFT JOIN commodities c ON c.guid = i.currency
            WHERE i.post_txn IS NOT NULL
              AND i.post_acc = ANY(${bookAccountGuids}::text[])
              AND i.owner_type IN (${OWNER_TYPE_VENDOR}, ${OWNER_TYPE_JOB})
              AND i.date_posted >= ${start} AND i.date_posted <= ${end}
        `,
        prisma.$queryRaw<{ guid: string; owner_type: number; owner_guid: string | null }[]>`
            SELECT guid, owner_type, owner_guid FROM jobs
        `,
        prisma.$queryRaw<{ guid: string; name: string }[]>`
            SELECT guid, name FROM vendors
        `,
    ]);

    const rows: RawPostedBillRow[] = billRows.map(r => ({
        guid: r.guid,
        ownerType: r.owner_type,
        ownerGuid: r.owner_guid,
        postedTotal: r.posted_total,
        lotBalance: r.lot_balance,
        currency: r.currency ?? 'USD',
    }));

    const jobOwners = new Map<string, JobOwnerRef>(
        jobRows.map(j => [j.guid, { ownerType: j.owner_type, ownerGuid: j.owner_guid }])
    );
    const vendorNames = new Map(vendorRows.map(v => [v.guid, v.name]));

    const { vendors, totals } = buildExpensesByVendor(rows, jobOwners, vendorNames);

    return {
        type: ReportType.EXPENSES_BY_VENDOR,
        title: 'Expenses by Vendor',
        generatedAt: new Date().toISOString(),
        filters,
        startDate,
        endDate,
        currency: dominantCurrency(rows),
        vendors,
        totals,
        sections: buildVendorSections(vendors, totals),
        grandTotal: totals.totalBilled,
    };
}
