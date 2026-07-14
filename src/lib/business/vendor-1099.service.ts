/**
 * 1099-NEC tracker — per-vendor cash paid for a calendar year, W-9 / TIN
 * tracking, and filing-status derivation.
 *
 * PAYMENT ATTRIBUTION (cash basis): 1099-NEC reports CASH PAID, not amounts
 * billed. A vendor bill posts a NEGATIVE split into its A/P `post_lot`;
 * every payment applied to that bill lands in the SAME lot as a POSITIVE
 * (debit) split on a different transaction. So "cash paid to a vendor in
 * year Y" = the sum of the vendor's bill-lot splits EXCLUDING the posting
 * transaction, restricted to transactions posted within Y. Credit-note
 * applications appear as negative amounts and net against payments — a
 * reasonable prep-worksheet approximation, documented on the report.
 *
 * TIN HANDLING: full TINs are NEVER accepted or stored. The API accepts the
 * LAST 4 DIGITS only; `maskTin` renders the stored display form
 * (***-**-1234 for individuals, **-***1234 for entities) and is the only
 * thing that ever reaches the database.
 */

import prisma from '@/lib/prisma';
import { OWNER_TYPE_JOB, OWNER_TYPE_VENDOR } from '@/lib/business/business-reports';

/* ------------------------------------------------------------------ */
/* Constants + pure helpers (unit-tested)                              */
/* ------------------------------------------------------------------ */

/** 1099-NEC reporting threshold (box 1 total for the calendar year). */
export const NEC_THRESHOLD = 600;

export const TAX_CLASSIFICATIONS = [
    'individual/sole_prop',
    'llc',
    'partnership',
    'c_corp',
    's_corp',
    'other',
] as const;
export type TaxClassification = (typeof TAX_CLASSIFICATIONS)[number];

/** Classifications that are generally exempt from 1099-NEC reporting. */
export const CORP_CLASSIFICATIONS: ReadonlySet<string> = new Set(['c_corp', 's_corp']);

export function isValidTaxClassification(value: unknown): value is TaxClassification {
    return typeof value === 'string' && (TAX_CLASSIFICATIONS as readonly string[]).includes(value);
}

export class Vendor1099ValidationError extends Error {}
export class Vendor1099NotFoundError extends Error {}

/**
 * Build the masked display TIN from the LAST 4 DIGITS ONLY.
 * Rejects anything that is not exactly 4 digits — a full SSN/EIN (with or
 * without dashes) is refused outright so a complete TIN can never be stored.
 * Individuals/sole props get SSN style (***-**-1234), everything else EIN
 * style (**-***1234).
 */
export function maskTin(last4: string, classification?: string | null): string {
    if (!/^\d{4}$/.test(last4)) {
        throw new Vendor1099ValidationError(
            'TIN must be the last 4 digits only (never send the full TIN)'
        );
    }
    return classification === 'individual/sole_prop' ? `***-**-${last4}` : `**-***${last4}`;
}

/** Parse and bound a ?year= query param (defaults to the current UTC year). */
export function parseYearParam(raw: string | null): number | null {
    if (raw === null || raw === '') return new Date().getUTCFullYear();
    const year = parseInt(raw, 10);
    if (!Number.isInteger(year) || year < 1990 || year > 2100) return null;
    return year;
}

export type Vendor1099Status = 'ready' | 'missing_w9' | 'exempt' | 'below_threshold';

/**
 * Filing status for one vendor-year. Precedence:
 *   exempt (corps etc., regardless of amount)
 *   → below_threshold (< $600 paid — no 1099 due, W-9 or not)
 *   → missing_w9 (reportable but no W-9 on file)
 *   → ready.
 */
export function derive1099Status(input: {
    totalPaid: number;
    exempt: boolean;
    w9Received: boolean;
}): Vendor1099Status {
    if (input.exempt) return 'exempt';
    if (input.totalPaid < NEC_THRESHOLD) return 'below_threshold';
    if (!input.w9Received) return 'missing_w9';
    return 'ready';
}

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export interface VendorTaxInfo {
    legalName: string | null;
    taxClassification: string | null;
    /** Display-only masked TIN, e.g. ***-**-1234. Never a full TIN. */
    taxIdMasked: string | null;
    w9Received: boolean;
    /** ISO date (YYYY-MM-DD) or null. */
    w9ReceivedDate: string | null;
    exemptFrom1099: boolean;
    address: string | null;
    notes: string | null;
}

export interface Vendor1099Row {
    vendorGuid: string;
    name: string;
    /** Cash paid to this vendor's bills during the year (see module header). */
    totalPaid: number;
    crosses600: boolean;
    taxInfo: VendorTaxInfo | null;
    status: Vendor1099Status;
}

export interface Vendor1099Summary {
    year: number;
    vendors: Vendor1099Row[];
    totals: {
        /** Vendors at/over the $600 threshold (exempt included in count). */
        reportableCount: number;
        /** Reportable vendors (≥ $600, not exempt) still missing a W-9. */
        missingW9Count: number;
        /** Sum paid to reportable, non-exempt vendors. */
        reportableTotal: number;
    };
}

/* ------------------------------------------------------------------ */
/* Pure aggregation (exported for tests)                                */
/* ------------------------------------------------------------------ */

const round2 = (n: number): number => {
    const r = Math.round(n * 100) / 100;
    return r === 0 ? 0 : r;
};

export interface VendorListEntry {
    guid: string;
    name: string;
    active: boolean;
}

/** Assemble summary rows: active vendors plus anyone actually paid in-year. */
export function buildVendor1099Summary(
    year: number,
    vendors: ReadonlyArray<VendorListEntry>,
    paidByVendor: ReadonlyMap<string, number>,
    taxInfoByVendor: ReadonlyMap<string, VendorTaxInfo>,
): Vendor1099Summary {
    const rows: Vendor1099Row[] = [];

    for (const vendor of vendors) {
        const totalPaid = round2(paidByVendor.get(vendor.guid) ?? 0);
        if (!vendor.active && totalPaid === 0) continue;

        const taxInfo = taxInfoByVendor.get(vendor.guid) ?? null;
        rows.push({
            vendorGuid: vendor.guid,
            name: vendor.name,
            totalPaid,
            crosses600: totalPaid >= NEC_THRESHOLD,
            taxInfo,
            status: derive1099Status({
                totalPaid,
                exempt: taxInfo?.exemptFrom1099 ?? false,
                w9Received: taxInfo?.w9Received ?? false,
            }),
        });
    }

    rows.sort((a, b) => b.totalPaid - a.totalPaid || a.name.localeCompare(b.name));

    const reportable = rows.filter((r) => r.crosses600);
    const nonExempt = reportable.filter((r) => r.status !== 'exempt');
    return {
        year,
        vendors: rows,
        totals: {
            reportableCount: reportable.length,
            missingW9Count: nonExempt.filter((r) => r.status === 'missing_w9').length,
            reportableTotal: round2(nonExempt.reduce((s, r) => s + r.totalPaid, 0)),
        },
    };
}

/* ------------------------------------------------------------------ */
/* DB loaders                                                           */
/* ------------------------------------------------------------------ */

const toIsoDate = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

interface TaxInfoDbRow {
    vendor_guid: string;
    legal_name: string | null;
    tax_classification: string | null;
    tax_id_masked: string | null;
    w9_received: boolean;
    w9_received_date: Date | null;
    exempt_from_1099: boolean;
    address: string | null;
    notes: string | null;
}

function mapTaxInfo(row: TaxInfoDbRow): VendorTaxInfo {
    return {
        legalName: row.legal_name,
        taxClassification: row.tax_classification,
        taxIdMasked: row.tax_id_masked,
        w9Received: row.w9_received,
        w9ReceivedDate: toIsoDate(row.w9_received_date),
        exemptFrom1099: row.exempt_from_1099,
        address: row.address,
        notes: row.notes,
    };
}

/**
 * 1099-NEC summary for a calendar year: every book vendor (vendors with at
 * least one bill posted into the book — the vendors table itself is not
 * book-scoped) that is active or was paid during the year.
 */
export async function get1099Summary(
    bookGuid: string,
    bookAccountGuids: string[],
    year: number,
): Promise<Vendor1099Summary> {
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));

    const [vendorRows, paidRows] = await Promise.all([
        // Vendors with any bill posted into this book (jobs resolved to owner).
        prisma.$queryRaw<{ guid: string; name: string; active: number }[]>`
            SELECT DISTINCT v.guid, v.name, v.active
            FROM invoices i
            LEFT JOIN jobs j ON i.owner_type = ${OWNER_TYPE_JOB} AND j.guid = i.owner_guid
            JOIN vendors v ON v.guid = (
                CASE WHEN i.owner_type = ${OWNER_TYPE_JOB} THEN j.owner_guid ELSE i.owner_guid END
            )
            WHERE i.post_txn IS NOT NULL
              AND i.post_acc = ANY(${bookAccountGuids}::text[])
              AND (CASE WHEN i.owner_type = ${OWNER_TYPE_JOB} THEN j.owner_type ELSE i.owner_type END) = ${OWNER_TYPE_VENDOR}
        `,
        // Cash paid in-year: A/P bill-lot splits excluding the posting txn.
        // Payments debit A/P (positive splits), so the sum reads positive.
        prisma.$queryRaw<{ vendor_guid: string; paid: number }[]>`
            WITH inv AS (
                SELECT
                    i.post_txn, i.post_lot,
                    CASE WHEN i.owner_type = ${OWNER_TYPE_JOB} THEN j.owner_guid ELSE i.owner_guid END AS eff_owner_guid,
                    CASE WHEN i.owner_type = ${OWNER_TYPE_JOB} THEN j.owner_type ELSE i.owner_type END AS eff_owner_type
                FROM invoices i
                LEFT JOIN jobs j ON i.owner_type = ${OWNER_TYPE_JOB} AND j.guid = i.owner_guid
                WHERE i.post_txn IS NOT NULL
                  AND i.post_lot IS NOT NULL
                  AND i.post_acc = ANY(${bookAccountGuids}::text[])
            )
            SELECT
                inv.eff_owner_guid AS vendor_guid,
                COALESCE(SUM(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric), 0)::float8 AS paid
            FROM inv
            JOIN splits s ON s.lot_guid = inv.post_lot AND s.tx_guid <> inv.post_txn
            JOIN transactions t ON t.guid = s.tx_guid
            WHERE inv.eff_owner_type = ${OWNER_TYPE_VENDOR}
              AND t.post_date >= ${start} AND t.post_date <= ${end}
            GROUP BY inv.eff_owner_guid
        `,
    ]);

    const paidByVendor = new Map(paidRows.map((r) => [r.vendor_guid, r.paid]));

    const guids = vendorRows.map((v) => v.guid);
    const taxRows = guids.length
        ? await prisma.gnucash_web_vendor_tax_info.findMany({
              where: { vendor_guid: { in: guids } },
          })
        : [];
    const taxInfoByVendor = new Map(taxRows.map((r) => [r.vendor_guid, mapTaxInfo(r)]));

    return buildVendor1099Summary(
        year,
        vendorRows.map((v) => ({ guid: v.guid, name: v.name, active: v.active !== 0 })),
        paidByVendor,
        taxInfoByVendor,
    );
}

/* ------------------------------------------------------------------ */
/* Tax info upsert                                                      */
/* ------------------------------------------------------------------ */

export interface UpsertVendorTaxInfoInput {
    legalName?: string | null;
    taxClassification?: string | null;
    /** Last 4 digits of the TIN, or null to clear. NEVER the full TIN. */
    tinLast4?: string | null;
    w9Received?: boolean;
    /** ISO date (YYYY-MM-DD) or null. */
    w9ReceivedDate?: string | null;
    exemptFrom1099?: boolean;
    address?: string | null;
    notes?: string | null;
}

/**
 * Create or update a vendor's 1099 tax info. `tinLast4` is validated to be
 * exactly 4 digits and stored ONLY in masked form. Omitted fields are left
 * unchanged; explicit nulls clear.
 */
export async function upsertVendorTaxInfo(
    bookGuid: string,
    vendorGuid: string,
    input: UpsertVendorTaxInfoInput,
): Promise<VendorTaxInfo> {
    const vendor = await prisma.$queryRaw<{ guid: string }[]>`
        SELECT guid FROM vendors WHERE guid = ${vendorGuid}
    `;
    if (vendor.length === 0) {
        throw new Vendor1099NotFoundError('Vendor not found');
    }

    if (
        input.taxClassification !== undefined &&
        input.taxClassification !== null &&
        !isValidTaxClassification(input.taxClassification)
    ) {
        throw new Vendor1099ValidationError(
            `Invalid tax classification (expected one of: ${TAX_CLASSIFICATIONS.join(', ')})`
        );
    }

    let w9Date: Date | null | undefined = undefined;
    if (input.w9ReceivedDate !== undefined) {
        if (input.w9ReceivedDate === null || input.w9ReceivedDate === '') {
            w9Date = null;
        } else {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(input.w9ReceivedDate)) {
                throw new Vendor1099ValidationError('w9ReceivedDate must be YYYY-MM-DD');
            }
            w9Date = new Date(`${input.w9ReceivedDate}T00:00:00.000Z`);
            if (isNaN(w9Date.getTime())) {
                throw new Vendor1099ValidationError('Invalid w9ReceivedDate');
            }
        }
    }

    const existing = await prisma.gnucash_web_vendor_tax_info.findUnique({
        where: { vendor_guid: vendorGuid },
    });

    // Masked TIN: recompute from last-4 when provided; re-mask the stored
    // last-4 when only the classification changes (style differs by type).
    const classification =
        input.taxClassification !== undefined
            ? input.taxClassification
            : (existing?.tax_classification ?? null);
    let taxIdMasked: string | null | undefined = undefined;
    if (input.tinLast4 !== undefined) {
        taxIdMasked = input.tinLast4 === null || input.tinLast4 === ''
            ? null
            : maskTin(input.tinLast4, classification);
    } else if (input.taxClassification !== undefined && existing?.tax_id_masked) {
        const last4 = existing.tax_id_masked.replace(/\D/g, '').slice(-4);
        taxIdMasked = last4.length === 4 ? maskTin(last4, classification) : existing.tax_id_masked;
    }

    const data = {
        book_guid: bookGuid,
        ...(input.legalName !== undefined && { legal_name: input.legalName }),
        ...(input.taxClassification !== undefined && { tax_classification: input.taxClassification }),
        ...(taxIdMasked !== undefined && { tax_id_masked: taxIdMasked }),
        ...(input.w9Received !== undefined && { w9_received: input.w9Received }),
        ...(w9Date !== undefined && { w9_received_date: w9Date }),
        ...(input.exemptFrom1099 !== undefined && { exempt_from_1099: input.exemptFrom1099 }),
        ...(input.address !== undefined && { address: input.address }),
        ...(input.notes !== undefined && { notes: input.notes }),
        updated_at: new Date(),
    };

    const row = await prisma.gnucash_web_vendor_tax_info.upsert({
        where: { vendor_guid: vendorGuid },
        create: { vendor_guid: vendorGuid, ...data },
        update: data,
    });

    return mapTaxInfo(row);
}
