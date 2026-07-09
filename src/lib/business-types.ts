/**
 * Business Foundation — client-safe types and constants.
 *
 * Shared between the business service/API routes (server) and the
 * business management pages (client). Keep this module free of any
 * server-only imports (prisma, auth) so client components can import
 * values from it safely.
 */

/** GnuCash GncOwnerType values used by jobs/invoices owner references. */
export const OWNER_TYPE_CUSTOMER = 2;
export const OWNER_TYPE_JOB = 3;
export const OWNER_TYPE_VENDOR = 4;

/** GnuCash GNC_AMT_TYPE values for taxtable entries. */
export const AMT_TYPE_VALUE = 1;
export const AMT_TYPE_PERCENT = 2;

/** GnuCash bill term type — we only support net-N day terms. */
export const TERM_TYPE_DAYS = 'GNC_TERM_TYPE_DAYS';

export type ContactKind = 'customer' | 'vendor';

export interface AddressDTO {
    name: string | null;
    addr1: string | null;
    addr2: string | null;
    addr3: string | null;
    addr4: string | null;
    phone: string | null;
    fax: string | null;
    email: string | null;
}

export interface CustomerDTO {
    guid: string;
    id: string;
    name: string;
    notes: string;
    active: boolean;
    /** Percent, e.g. 5 means 5% default discount. */
    discount: number;
    /** Credit limit in the customer's currency. */
    credit: number;
    /** Currency mnemonic, e.g. 'USD'. */
    currency: string;
    taxOverride: boolean;
    taxIncluded: boolean;
    address: AddressDTO;
    shipAddress: AddressDTO;
    /** Bill terms guid or null. */
    terms: string | null;
    termsName: string | null;
    /** Tax table guid or null. */
    taxtable: string | null;
    taxtableName: string | null;
    jobCount: number;
}

export interface VendorDTO {
    guid: string;
    id: string;
    name: string;
    notes: string;
    active: boolean;
    /** Currency mnemonic, e.g. 'USD'. */
    currency: string;
    taxOverride: boolean;
    taxIncluded: boolean;
    address: AddressDTO;
    terms: string | null;
    termsName: string | null;
    taxtable: string | null;
    taxtableName: string | null;
    jobCount: number;
}

export interface JobDTO {
    guid: string;
    id: string;
    name: string;
    reference: string;
    active: boolean;
    ownerType: ContactKind | null;
    ownerGuid: string | null;
    ownerName: string | null;
}

export interface BilltermDTO {
    guid: string;
    name: string;
    description: string;
    refcount: number;
    invisible: boolean;
    /** Net-N days until due. */
    dueDays: number;
    /** Days within which the early-payment discount applies. */
    discountDays: number;
    /** Early-payment discount percent. */
    discountPercent: number;
}

export interface TaxtableEntryDTO {
    id: number;
    /** Target account guid (tax liability/expense account). */
    account: string;
    accountName: string | null;
    /** Percent when type='percent', fixed currency amount when type='value'. */
    amount: number;
    type: 'value' | 'percent';
}

export interface TaxtableDTO {
    guid: string;
    name: string;
    refcount: number;
    invisible: boolean;
    entries: TaxtableEntryDTO[];
}
