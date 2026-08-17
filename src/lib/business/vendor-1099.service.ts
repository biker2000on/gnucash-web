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
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { OWNER_TYPE_JOB, OWNER_TYPE_VENDOR } from '@/lib/business/business-reports';
import {
    summarizeVendor1099Compliance,
    type Vendor1099ComplianceSummary,
} from '@/lib/business/vendor-1099-compliance';
import { getNecThreshold } from '@/lib/reports/irs-limits';

/* ------------------------------------------------------------------ */
/* Constants + pure helpers (unit-tested)                              */
/* ------------------------------------------------------------------ */

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

/**
 * The general 1099-NEC corporate exemption. A vendor marked as receiving
 * attorney or medical payments remains reportable regardless of classification.
 */
export function isVendor1099Exempt(taxInfo: VendorTaxInfo | null | undefined): boolean {
    if (taxInfo?.attorneyOrMedicalPayments) return false;
    if (taxInfo?.exemptFrom1099Override !== null && taxInfo?.exemptFrom1099Override !== undefined) {
        return taxInfo.exemptFrom1099Override;
    }
    return CORP_CLASSIFICATIONS.has(taxInfo?.taxClassification ?? '');
}

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

/** Parse and bound a ?year= query param (defaults to the newest verified built-in year). */
export function parseYearParam(raw: string | null): number | null {
    if (raw === null || raw === '') return 2026;
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
    threshold: number;
}): Vendor1099Status {
    if (input.exempt) return 'exempt';
    if (input.totalPaid < input.threshold) return 'below_threshold';
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
    /** ISO date (YYYY-MM-DD) the W-9 was requested from the vendor, or null. */
    w9RequestedDate: string | null;
    exemptFrom1099: boolean;
    /** null = corporation default; boolean = an explicit user decision. */
    exemptFrom1099Override: boolean | null;
    /** Attorney-fee or medical/health-care payments remain reportable to corporations. */
    attorneyOrMedicalPayments?: boolean;
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
    /** ISO date (YYYY-MM-DD) the 1099-NEC was filed for this year, or null. */
    filedDate: string | null;
}

export interface Vendor1099Summary {
    year: number;
    threshold: number;
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

/** A card/network-funded payment is reported by the settlement entity on 1099-K. */
export function aggregateEligibleVendorPayments(
    payments: ReadonlyArray<{
        vendorGuid: string;
        paid: number;
        cardFundingAmount: number;
        totalFundingAmount: number;
    }>,
): Map<string, number> {
    const totals = new Map<string, number>();
    for (const payment of payments) {
        // Funding legs are only cash/settlement balance-sheet accounts
        // (ASSET/BANK/CASH/LIABILITY/CREDIT), never expense, discount, or
        // rounding splits. Settle at most the A/P amount, then apportion that
        // settled amount by card vs non-card funding; any residual is explicit
        // non-cash settlement and is not treated as 1099 cash paid.
        const totalFunding = Math.max(0, payment.totalFundingAmount);
        const cardFunding = Math.min(totalFunding, Math.max(0, payment.cardFundingAmount));
        const settledMagnitude = Math.min(Math.abs(payment.paid), totalFunding);
        const nonCardRatio = totalFunding > 0 ? (totalFunding - cardFunding) / totalFunding : 0;
        const eligiblePaid = round2(Math.sign(payment.paid) * settledMagnitude * nonCardRatio);
        totals.set(payment.vendorGuid, round2((totals.get(payment.vendorGuid) ?? 0) + eligiblePaid));
    }
    return totals;
}

/** Assemble summary rows: active vendors plus anyone actually paid in-year. */
export function buildVendor1099Summary(
    year: number,
    vendors: ReadonlyArray<VendorListEntry>,
    paidByVendor: ReadonlyMap<string, number>,
    taxInfoByVendor: ReadonlyMap<string, VendorTaxInfo>,
    filedByVendor: ReadonlyMap<string, string> = new Map(),
    threshold: number,
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
            crosses600: totalPaid >= threshold,
            taxInfo,
            status: derive1099Status({
                totalPaid,
                exempt: isVendor1099Exempt(taxInfo),
                w9Received: taxInfo?.w9Received ?? false,
                threshold,
            }),
            filedDate: filedByVendor.get(vendor.guid) ?? null,
        });
    }

    rows.sort((a, b) => b.totalPaid - a.totalPaid || a.name.localeCompare(b.name));

    const reportable = rows.filter((r) => r.crosses600);
    const nonExempt = reportable.filter((r) => r.status !== 'exempt');
    return {
        year,
        threshold,
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

export interface TaxInfoDbRow {
    vendor_guid: string;
    legal_name: string | null;
    tax_classification: string | null;
    tax_id_masked: string | null;
    w9_received: boolean;
    w9_received_date: Date | null;
    w9_requested_date: Date | null;
    exempt_from_1099: boolean;
    exempt_from_1099_override?: boolean | null;
    exempt_from_1099_override_initialized?: boolean;
    attorney_or_medical_payments?: boolean;
    address: string | null;
    notes: string | null;
}

export function mapTaxInfo(row: TaxInfoDbRow): VendorTaxInfo {
    const taxInfo: VendorTaxInfo = {
        legalName: row.legal_name,
        taxClassification: row.tax_classification,
        taxIdMasked: row.tax_id_masked,
        w9Received: row.w9_received,
        w9ReceivedDate: toIsoDate(row.w9_received_date),
        w9RequestedDate: toIsoDate(row.w9_requested_date),
        exemptFrom1099: false,
        exemptFrom1099Override: row.exempt_from_1099_override ?? null,
        attorneyOrMedicalPayments: row.attorney_or_medical_payments ?? false,
        address: row.address,
        notes: row.notes,
    };
    taxInfo.exemptFrom1099 = isVendor1099Exempt(taxInfo);
    return taxInfo;
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

    const [vendorRows, paidRows, threshold] = await Promise.all([
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
        // Payments funded by an account marked as a payment-card / third-party
        // network source are excluded: their settlement entity reports them on
        // Form 1099-K, not this payer's 1099-NEC. Payments debit A/P (positive
        // splits), so the sum reads positive.
        prisma.$queryRaw<{ vendor_guid: string; paid: number; card_funding_amount: number; total_funding_amount: number }[]>`
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
                (s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric)::float8 AS paid,
                funding.card_funding_amount,
                funding.total_funding_amount
            FROM inv
            JOIN splits s ON s.lot_guid = inv.post_lot AND s.tx_guid <> inv.post_txn
            JOIN transactions t ON t.guid = s.tx_guid
            CROSS JOIN LATERAL (
                SELECT
                    COALESCE(SUM(ABS(funding.value_num::numeric / NULLIF(funding.value_denom, 0)::numeric))
                      FILTER (WHERE funding_pref.is_card_payment_source = true), 0)::float8 AS card_funding_amount,
                    COALESCE(SUM(ABS(funding.value_num::numeric / NULLIF(funding.value_denom, 0)::numeric)), 0)::float8 AS total_funding_amount
                FROM splits funding
                JOIN accounts funding_account ON funding_account.guid = funding.account_guid
                LEFT JOIN gnucash_web_account_preferences funding_pref ON funding_pref.account_guid = funding.account_guid
                WHERE funding.tx_guid = s.tx_guid
                  AND funding.guid <> s.guid
                  AND funding_account.account_type IN ('ASSET', 'BANK', 'CASH', 'LIABILITY', 'CREDIT')
            ) funding
            WHERE inv.eff_owner_type = ${OWNER_TYPE_VENDOR}
              AND t.post_date >= ${start} AND t.post_date <= ${end}
        `,
        getNecThreshold(year),
    ]);

    if (threshold === null) {
        throw new Vendor1099ValidationError(
            `No verified 1099-NEC threshold is configured for tax year ${year}`,
        );
    }

    const paidByVendor = aggregateEligibleVendorPayments(paidRows.map((r) => ({
        vendorGuid: r.vendor_guid,
        paid: r.paid,
        cardFundingAmount: r.card_funding_amount,
        totalFundingAmount: r.total_funding_amount,
    })));

    const guids = vendorRows.map((v) => v.guid);
    const [taxRows, filingRows] = guids.length
        ? await Promise.all([
              prisma.gnucash_web_vendor_tax_info.findMany({
                  where: { vendor_guid: { in: guids }, book_guid: bookGuid },
              }),
              prisma.gnucash_web_vendor_1099_filings.findMany({
                  where: { vendor_guid: { in: guids }, tax_year: year, book_guid: bookGuid },
              }),
          ])
        : [[], []];
    const taxInfoByVendor = new Map(taxRows.map((r) => [r.vendor_guid, mapTaxInfo(r)]));
    const filedByVendor = new Map(
        filingRows.flatMap((r) => {
            const filed = toIsoDate(r.filed_1099_nec);
            return filed ? [[r.vendor_guid, filed] as const] : [];
        }),
    );

    return buildVendor1099Summary(
        year,
        vendorRows.map((v) => ({ guid: v.guid, name: v.name, active: v.active !== 0 })),
        paidByVendor,
        taxInfoByVendor,
        filedByVendor,
        threshold,
    );
}

/* ------------------------------------------------------------------ */
/* Compliance rollup (Action Center + Money Timeline + page banner)     */
/* ------------------------------------------------------------------ */

/**
 * Load the year's vendor summary and run the deterministic compliance engine
 * over it: over-threshold flags, W-9 tracking state, the Jan 31 due date,
 * days until due, and per-vendor filing status.
 */
export async function get1099Compliance(
    bookGuid: string,
    bookAccountGuids: string[],
    taxYear: number,
    asOf: Date = new Date(),
): Promise<Vendor1099ComplianceSummary> {
    const [summary, threshold] = await Promise.all([
        get1099Summary(bookGuid, bookAccountGuids, taxYear),
        getNecThreshold(taxYear),
    ]);
    if (threshold === null) {
        throw new Vendor1099ValidationError(
            `No verified 1099-NEC threshold is configured for tax year ${taxYear}`,
        );
    }
    return summarizeVendor1099Compliance(
        taxYear,
        summary.vendors.map((row) => ({
            vendorGuid: row.vendorGuid,
            name: row.name,
            totalPaid: row.totalPaid,
            exemptFrom1099: isVendor1099Exempt(row.taxInfo),
            w9Received: row.taxInfo?.w9Received ?? false,
            w9RequestedDate: row.taxInfo?.w9RequestedDate ?? null,
            tinOnFile: (row.taxInfo?.taxIdMasked ?? null) !== null,
            filedDate: row.filedDate,
        })),
        asOf,
        threshold,
    );
}

/* ------------------------------------------------------------------ */
/* Per-year filing status                                               */
/* ------------------------------------------------------------------ */

/**
 * Record (or clear, with `filedDate: null`) the date a 1099-NEC was filed
 * for a vendor-year. Dates are ISO YYYY-MM-DD; only the date is stored.
 */
export async function setVendor1099Filing(
    bookGuid: string,
    vendorGuid: string,
    taxYear: number,
    filedDate: string | null,
): Promise<{ vendorGuid: string; taxYear: number; filedDate: string | null }> {
    await assertVendor1099BookScope(bookGuid, vendorGuid);
    if (!Number.isInteger(taxYear) || taxYear < 1990 || taxYear > 2100) {
        throw new Vendor1099ValidationError('Invalid tax year');
    }

    let filed: Date | null = null;
    if (filedDate !== null && filedDate !== '') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(filedDate)) {
            throw new Vendor1099ValidationError('filedDate must be YYYY-MM-DD');
        }
        filed = new Date(`${filedDate}T00:00:00.000Z`);
        if (isNaN(filed.getTime())) {
            throw new Vendor1099ValidationError('Invalid filedDate');
        }
    }

    const ownership = await prisma.gnucash_web_vendor_1099_filings.findUnique({
        where: { vendor_guid_tax_year: { vendor_guid: vendorGuid, tax_year: taxYear } },
        select: { book_guid: true },
    });
    if (ownership && ownership.book_guid !== bookGuid) {
        throw new Vendor1099NotFoundError('Vendor filing not found in this book');
    }

    if (filed === null) {
        await prisma.gnucash_web_vendor_1099_filings.deleteMany({
            where: { vendor_guid: vendorGuid, tax_year: taxYear, book_guid: bookGuid },
        });
        return { vendorGuid, taxYear, filedDate: null };
    }

    const row = ownership
        ? await prisma.gnucash_web_vendor_1099_filings.update({
            where: { vendor_guid_tax_year: { vendor_guid: vendorGuid, tax_year: taxYear } },
            data: { filed_1099_nec: filed, updated_at: new Date() },
        })
        : await prisma.gnucash_web_vendor_1099_filings.create({
          data: {
            vendor_guid: vendorGuid,
            tax_year: taxYear,
            book_guid: bookGuid,
            filed_1099_nec: filed,
          },
        });
    return { vendorGuid, taxYear, filedDate: toIsoDate(row.filed_1099_nec) };
}

/**
 * A vendor GUID is global in the GnuCash schema, so its bare existence cannot
 * authorize a book-scoped 1099 mutation. A vendor is eligible here only when
 * it owns a posted bill in one of the active book's accounts.
 */
export async function assertVendor1099BookScope(
    bookGuid: string,
    vendorGuid: string,
): Promise<void> {
    const bookAccountGuids = await getAccountGuidsForBook(bookGuid);
    if (bookAccountGuids.length === 0) {
        throw new Vendor1099NotFoundError('Vendor not found in this book');
    }

    const vendor = await prisma.$queryRaw<{ guid: string }[]>`
        SELECT DISTINCT v.guid
        FROM invoices i
        LEFT JOIN jobs j ON i.owner_type = ${OWNER_TYPE_JOB} AND j.guid = i.owner_guid
        JOIN vendors v ON v.guid = (
            CASE WHEN i.owner_type = ${OWNER_TYPE_JOB} THEN j.owner_guid ELSE i.owner_guid END
        )
        WHERE i.post_txn IS NOT NULL
          AND i.post_acc = ANY(${bookAccountGuids}::text[])
          AND (CASE WHEN i.owner_type = ${OWNER_TYPE_JOB} THEN j.owner_type ELSE i.owner_type END) = ${OWNER_TYPE_VENDOR}
          AND v.guid = ${vendorGuid}
        LIMIT 1
    `;
    if (vendor.length === 0) {
        throw new Vendor1099NotFoundError('Vendor not found in this book');
    }
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
    /** ISO date (YYYY-MM-DD) the W-9 was requested, or null. */
    w9RequestedDate?: string | null;
    /** Explicit override; null restores the corporation-default behavior. */
    exemptFrom1099Override?: boolean | null;
    /** Set when this vendor receives attorney or medical/health-care payments. */
    attorneyOrMedicalPayments?: boolean;
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
    await assertVendor1099BookScope(bookGuid, vendorGuid);

    if (
        input.taxClassification !== undefined &&
        input.taxClassification !== null &&
        !isValidTaxClassification(input.taxClassification)
    ) {
        throw new Vendor1099ValidationError(
            `Invalid tax classification (expected one of: ${TAX_CLASSIFICATIONS.join(', ')})`
        );
    }

    const parseIsoDateInput = (
        value: string | null | undefined,
        field: string,
    ): Date | null | undefined => {
        if (value === undefined) return undefined;
        if (value === null || value === '') return null;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            throw new Vendor1099ValidationError(`${field} must be YYYY-MM-DD`);
        }
        const parsed = new Date(`${value}T00:00:00.000Z`);
        if (isNaN(parsed.getTime())) {
            throw new Vendor1099ValidationError(`Invalid ${field}`);
        }
        return parsed;
    };
    const w9Date = parseIsoDateInput(input.w9ReceivedDate, 'w9ReceivedDate');
    const w9Requested = parseIsoDateInput(input.w9RequestedDate, 'w9RequestedDate');

    // Read ownership only before touching sensitive metadata. A legacy/global
    // row or a row owned by another book must never be adopted or overwritten.
    const ownership = await prisma.gnucash_web_vendor_tax_info.findUnique({
        where: { vendor_guid: vendorGuid },
        select: { book_guid: true },
    });
    if (ownership && ownership.book_guid !== bookGuid) {
        throw new Vendor1099NotFoundError('Vendor tax info not found in this book');
    }
    const existing = ownership
        ? await prisma.gnucash_web_vendor_tax_info.findUnique({
            where: { vendor_guid: vendorGuid },
            select: { tax_classification: true, tax_id_masked: true },
        })
        : null;

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
        ...(input.legalName !== undefined && { legal_name: input.legalName }),
        ...(input.taxClassification !== undefined && { tax_classification: input.taxClassification }),
        ...(taxIdMasked !== undefined && { tax_id_masked: taxIdMasked }),
        ...(input.w9Received !== undefined && { w9_received: input.w9Received }),
        ...(w9Date !== undefined && { w9_received_date: w9Date }),
        ...(w9Requested !== undefined && { w9_requested_date: w9Requested }),
        ...(input.exemptFrom1099Override !== undefined && {
            exempt_from_1099_override: input.exemptFrom1099Override,
            // Kept populated for compatibility with old readers/migrations.
            exempt_from_1099: input.exemptFrom1099Override ?? false,
        }),
        ...(input.attorneyOrMedicalPayments !== undefined && {
            attorney_or_medical_payments: input.attorneyOrMedicalPayments,
        }),
        ...(ownership === null && { exempt_from_1099_override_initialized: true }),
        ...(input.address !== undefined && { address: input.address }),
        ...(input.notes !== undefined && { notes: input.notes }),
        updated_at: new Date(),
    };

    // Avoid upsert-by-global-vendor: create can fail on a concurrent owner,
    // but it can never silently rewrite that owner's book_guid.
    const row = ownership
        ? await prisma.gnucash_web_vendor_tax_info.update({
            where: { vendor_guid: vendorGuid },
            data,
        })
        : await prisma.gnucash_web_vendor_tax_info.create({
            data: { vendor_guid: vendorGuid, book_guid: bookGuid, ...data },
        });

    return mapTaxInfo(row);
}
