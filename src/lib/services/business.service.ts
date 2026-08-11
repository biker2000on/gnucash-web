/**
 * Business Foundation Service
 *
 * CRUD for the native GnuCash business tables: customers, vendors, jobs,
 * billterms and taxtables (+ entries). These tables come straight from the
 * GnuCash desktop SQL backend, so we preserve its conventions:
 *
 * - guids are 32-char lowercase hex (generateGuid from '@/lib/gnucash')
 * - `active` / `invisible` are int flags (1/0)
 * - discount/credit/amount are gnc_numeric fractions (num/denom BigInt).
 *   Discounts and tax percentages use denom 10000 (percent with 4 decimal
 *   places, matching GnuCash's percent precision); currency-like amounts
 *   (credit limit, fixed tax value) use denom 100.
 * - `currency` columns store the commodity GUID of a CURRENCY commodity
 *   (GnuCash desktop stores a guid reference, not the mnemonic). The API
 *   surface accepts/returns mnemonics ('USD') and this service translates.
 * - entity `id` is a human-readable zero-padded counter ('000001'). GnuCash
 *   desktop keeps counters in the books' slots; we instead derive the next
 *   id as max(existing numeric ids) + 1, which is simpler and safe because
 *   this app is the only writer expected to create business entities here.
 *
 * BOOK SCOPING: the native business tables have no book_guid column
 * (GnuCash assumes one book per database), so ownership lives in the
 * app-owned side table behind '@/lib/business/entity-ownership'. Every
 * exported read/write takes `bookGuid` as its first positional parameter —
 * required and positional so a missed call site is a compile error rather
 * than a silent cross-book leak. Missing ownership means FOREIGN: an
 * unattributed row is invisible, never visible to everyone.
 *
 * Deletion: rows referenced by jobs/invoices/contacts are never hard
 * deleted; they fall back to deactivation (active=0) or invisibility
 * (invisible=1 for billterms/taxtables), matching GnuCash desktop behavior.
 */

import { z } from 'zod';
import prisma from '@/lib/prisma';
import { generateGuid, fromDecimal, toDecimalNumber } from '@/lib/gnucash';
import {
  isEntityOwnedByBook,
  getEntityOwnerBook,
  recordEntityOwnership,
  deleteEntityOwnership,
  type EntityOwnershipClient,
} from '@/lib/business/entity-ownership';
import {
  OWNER_TYPE_CUSTOMER,
  OWNER_TYPE_JOB,
  OWNER_TYPE_VENDOR,
  AMT_TYPE_VALUE,
  AMT_TYPE_PERCENT,
  TERM_TYPE_DAYS,
  type AddressDTO,
  type CustomerDTO,
  type VendorDTO,
  type JobDTO,
  type BilltermDTO,
  type TaxtableDTO,
  type ContactKind,
} from '@/lib/business-types';

/** Thrown for caller-fixable input problems; API routes map this to HTTP 400. */
export class BusinessValidationError extends Error {}

/** Denominator for percent-like fractions (discounts, tax percentages). */
export const PERCENT_DENOM = 10000;
/** Denominator for currency-like fractions (credit limits, fixed tax values). */
export const CURRENCY_DENOM = 100;

// ============================================
// Pure helpers (unit tested)
// ============================================

/**
 * Compute the next human-readable entity id from the existing ids of one
 * entity type: max numeric id + 1, zero-padded to 6 digits ('000001').
 * Non-numeric ids are ignored; gaps are not reused. Ids that already exceed
 * 6 digits keep their natural width.
 */
export function nextEntityId(existingIds: string[]): string {
  let max = 0;
  for (const raw of existingIds) {
    const trimmed = String(raw ?? '').trim();
    if (!/^\d+$/.test(trimmed)) continue;
    const n = parseInt(trimmed, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1).padStart(6, '0');
}

/** Percent (e.g. 8.25) to a gnc_numeric fraction with denom 10000. */
export function percentToFraction(value: number): { num: bigint; denom: bigint } {
  return fromDecimal(value, PERCENT_DENOM);
}

/** Currency amount to a gnc_numeric fraction with denom 100. */
export function currencyToFraction(value: number): { num: bigint; denom: bigint } {
  return fromDecimal(value, CURRENCY_DENOM);
}

/** Fraction back to a plain number (0 when either part is null). */
export function fractionToNumber(
  num: bigint | number | string | null,
  denom: bigint | number | string | null
): number {
  return toDecimalNumber(num, denom);
}

// ============================================
// Validation schemas
// ============================================

const guidSchema = z.string().regex(/^[0-9a-f]{32}$/, 'must be a 32-char hex guid');

const addressSchema = z.object({
  name: z.string().max(1024).nullish(),
  addr1: z.string().max(1024).nullish(),
  addr2: z.string().max(1024).nullish(),
  addr3: z.string().max(1024).nullish(),
  addr4: z.string().max(1024).nullish(),
  phone: z.string().max(128).nullish(),
  fax: z.string().max(128).nullish(),
  email: z.string().max(256).nullish(),
});

export const customerInputSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(2048),
  notes: z.string().max(2048).default(''),
  active: z.boolean().default(true),
  currency: z.string().trim().min(3).max(10).default('USD'),
  discount: z.number().min(0).max(100).default(0),
  credit: z.number().min(0).default(0),
  taxOverride: z.boolean().default(false),
  taxIncluded: z.boolean().default(false),
  address: addressSchema.default({}),
  shipAddress: addressSchema.default({}),
  terms: guidSchema.nullish(),
  taxtable: guidSchema.nullish(),
});
export type CustomerInput = z.infer<typeof customerInputSchema>;

export const vendorInputSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(2048),
  notes: z.string().max(2048).default(''),
  active: z.boolean().default(true),
  currency: z.string().trim().min(3).max(10).default('USD'),
  taxOverride: z.boolean().default(false),
  taxIncluded: z.boolean().default(false),
  address: addressSchema.default({}),
  terms: guidSchema.nullish(),
  taxtable: guidSchema.nullish(),
});
export type VendorInput = z.infer<typeof vendorInputSchema>;

export const jobInputSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(2048),
  reference: z.string().max(2048).default(''),
  active: z.boolean().default(true),
  ownerType: z.enum(['customer', 'vendor']),
  ownerGuid: guidSchema,
});
export type JobInput = z.infer<typeof jobInputSchema>;

export const billtermInputSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(2048),
  description: z.string().max(2048).default(''),
  dueDays: z.number().int().min(0).max(3650),
  discountDays: z.number().int().min(0).max(3650).default(0),
  discountPercent: z.number().min(0).max(100).default(0),
});
export type BilltermInput = z.infer<typeof billtermInputSchema>;

export const taxtableEntryInputSchema = z.object({
  account: guidSchema,
  amount: z.number().min(0),
  type: z.enum(['value', 'percent']),
});

export const taxtableInputSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(50),
  entries: z.array(taxtableEntryInputSchema).min(1, 'at least one entry is required'),
});
export type TaxtableInput = z.infer<typeof taxtableInputSchema>;

/** Parse with zod, converting failures to BusinessValidationError. */
export function parseInput<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first.path.length > 0 ? `${first.path.join('.')}: ` : '';
    throw new BusinessValidationError(`${path}${first.message}`);
  }
  return result.data;
}

// ============================================
// Book scope helpers
// ============================================

/** Prisma's transaction client satisfies the ownership helper structurally. */
type TxClient = Omit<typeof prisma, '$transaction' | '$connect' | '$disconnect' | '$on' | '$use' | '$extends'>;

function ownershipTx(tx: TxClient): EntityOwnershipClient {
  return tx as unknown as EntityOwnershipClient;
}

// ============================================
// Currency resolution
// ============================================

async function resolveCurrencyGuid(mnemonic: string): Promise<string> {
  const commodity = await prisma.commodities.findFirst({
    where: { namespace: 'CURRENCY', mnemonic: mnemonic.toUpperCase() },
    select: { guid: true },
  });
  if (!commodity) {
    throw new BusinessValidationError(`Unknown currency: ${mnemonic}`);
  }
  return commodity.guid;
}

async function currencyMnemonicMap(guids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(guids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await prisma.commodities.findMany({
    where: { guid: { in: unique } },
    select: { guid: true, mnemonic: true },
  });
  return new Map(rows.map(r => [r.guid, r.mnemonic]));
}

// ============================================
// Refcount management (billterms / taxtables)
// ============================================

/**
 * Recompute the refcount of a bill term from its referencing customers,
 * vendors and invoices. GnuCash increments/decrements; recomputing is
 * simpler and self-healing for these small tables.
 */
export async function recomputeBilltermRefcount(guid: string): Promise<void> {
  // Count only references from the term's OWN book. Validation now forbids
  // referencing another book's term, so a cross-book reference can only be
  // legacy pre-ownership data — and counting it would let another book's rows
  // block this one from hard-deleting a term it no longer uses. An
  // unattributed term keeps the old unscoped count (it is invisible anyway,
  // so over-counting is the safe direction).
  const bookGuid = await getEntityOwnerBook('billterm', guid);
  const scope = bookGuid ? { ownership: { book_guid: bookGuid } } : {};
  const [customers, vendors, invoices] = await Promise.all([
    prisma.customers.count({ where: { terms: guid, ...scope } }),
    prisma.vendors.count({ where: { terms: guid, ...scope } }),
    prisma.invoices.count({ where: { terms: guid, ...scope } }),
  ]);
  await prisma.billterms.updateMany({
    where: { guid },
    data: { refcount: customers + vendors + invoices },
  });
}

/** Recompute the refcount of a tax table from customers, vendors and entries. */
export async function recomputeTaxtableRefcount(guid: string): Promise<void> {
  // Same reasoning as recomputeBilltermRefcount: scope to the owning book so
  // legacy cross-book references cannot pin a table this book wants to delete.
  const bookGuid = await getEntityOwnerBook('taxtable', guid);
  const scope = bookGuid ? { ownership: { book_guid: bookGuid } } : {};
  // `entries` has no ownership of its own — it inherits its invoice's — and no
  // Prisma relation to invoices, so the scoped count needs an explicit join.
  const entryCounts = bookGuid
    ? await prisma.$queryRaw<Array<{ i_count: number; b_count: number }>>`
        SELECT
          COUNT(*) FILTER (WHERE e.i_taxtable = ${guid})::int AS i_count,
          COUNT(*) FILTER (WHERE e.b_taxtable = ${guid})::int AS b_count
        FROM entries e
        JOIN gnucash_web_invoice_ownership io
          ON io.entity_guid = e.invoice AND io.book_guid = ${bookGuid}
        WHERE e.i_taxtable = ${guid} OR e.b_taxtable = ${guid}
      `
    : null;
  const [customers, vendors, iEntries, bEntries] = await Promise.all([
    prisma.customers.count({ where: { taxtable: guid, ...scope } }),
    prisma.vendors.count({ where: { tax_table: guid, ...scope } }),
    entryCounts ? entryCounts[0]?.i_count ?? 0 : prisma.entries.count({ where: { i_taxtable: guid } }),
    entryCounts ? entryCounts[0]?.b_count ?? 0 : prisma.entries.count({ where: { b_taxtable: guid } }),
  ]);
  await prisma.taxtables.updateMany({
    where: { guid },
    data: { refcount: BigInt(customers + vendors + iEntries + bEntries) },
  });
}

async function recomputeChangedRefs(
  kind: 'billterm' | 'taxtable',
  ...guids: Array<string | null | undefined>
): Promise<void> {
  const unique = [...new Set(guids.filter((g): g is string => Boolean(g)))];
  for (const guid of unique) {
    if (kind === 'billterm') await recomputeBilltermRefcount(guid);
    else await recomputeTaxtableRefcount(guid);
  }
}

// ============================================
// Customers
// ============================================

type CustomerRow = NonNullable<Awaited<ReturnType<typeof prisma.customers.findUnique>>>;

function mapAddress(row: Record<string, unknown>, prefix: 'addr' | 'shipaddr'): AddressDTO {
  return {
    name: (row[`${prefix}_name`] as string | null) ?? null,
    addr1: (row[`${prefix}_addr1`] as string | null) ?? null,
    addr2: (row[`${prefix}_addr2`] as string | null) ?? null,
    addr3: (row[`${prefix}_addr3`] as string | null) ?? null,
    addr4: (row[`${prefix}_addr4`] as string | null) ?? null,
    phone: (row[`${prefix}_phone`] as string | null) ?? null,
    fax: (row[`${prefix}_fax`] as string | null) ?? null,
    email: (row[`${prefix}_email`] as string | null) ?? null,
  };
}

function addressToColumns(
  address: z.infer<typeof addressSchema>,
  prefix: 'addr' | 'shipaddr'
): Record<string, string | null> {
  return {
    [`${prefix}_name`]: address.name?.trim() || null,
    [`${prefix}_addr1`]: address.addr1?.trim() || null,
    [`${prefix}_addr2`]: address.addr2?.trim() || null,
    [`${prefix}_addr3`]: address.addr3?.trim() || null,
    [`${prefix}_addr4`]: address.addr4?.trim() || null,
    [`${prefix}_phone`]: address.phone?.trim() || null,
    [`${prefix}_fax`]: address.fax?.trim() || null,
    [`${prefix}_email`]: address.email?.trim() || null,
  };
}

interface ContactLookups {
  currencies: Map<string, string>;
  termNames: Map<string, string>;
  taxtableNames: Map<string, string>;
  jobCounts: Map<string, number>;
}

async function contactLookups(rows: Array<{
  guid: string;
  currency: string;
  terms: string | null;
  taxtable?: string | null;
  tax_table?: string | null;
}>, ownerType: number): Promise<ContactLookups> {
  const termGuids = rows.map(r => r.terms).filter((g): g is string => Boolean(g));
  const taxGuids = rows
    .map(r => r.taxtable ?? r.tax_table)
    .filter((g): g is string => Boolean(g));

  const [currencies, terms, taxtables, jobs] = await Promise.all([
    currencyMnemonicMap(rows.map(r => r.currency)),
    termGuids.length > 0
      ? prisma.billterms.findMany({ where: { guid: { in: termGuids } }, select: { guid: true, name: true } })
      : Promise.resolve([]),
    taxGuids.length > 0
      ? prisma.taxtables.findMany({ where: { guid: { in: taxGuids } }, select: { guid: true, name: true } })
      : Promise.resolve([]),
    rows.length > 0
      ? prisma.jobs.groupBy({
          by: ['owner_guid'],
          where: { owner_type: ownerType, owner_guid: { in: rows.map(r => r.guid) } },
          _count: { guid: true },
        })
      : Promise.resolve([]),
  ]);

  return {
    currencies,
    termNames: new Map(terms.map(t => [t.guid, t.name])),
    taxtableNames: new Map(taxtables.map(t => [t.guid, t.name])),
    jobCounts: new Map(
      jobs.map(j => [j.owner_guid as string, j._count.guid])
    ),
  };
}

function mapCustomer(row: CustomerRow, lookups: ContactLookups): CustomerDTO {
  return {
    guid: row.guid,
    id: row.id,
    name: row.name,
    notes: row.notes,
    active: row.active === 1,
    discount: fractionToNumber(row.discount_num, row.discount_denom),
    credit: fractionToNumber(row.credit_num, row.credit_denom),
    currency: lookups.currencies.get(row.currency) ?? row.currency,
    taxOverride: row.tax_override === 1,
    taxIncluded: row.tax_included === 1,
    address: mapAddress(row as unknown as Record<string, unknown>, 'addr'),
    shipAddress: mapAddress(row as unknown as Record<string, unknown>, 'shipaddr'),
    terms: row.terms,
    termsName: row.terms ? lookups.termNames.get(row.terms) ?? null : null,
    taxtable: row.taxtable,
    taxtableName: row.taxtable ? lookups.taxtableNames.get(row.taxtable) ?? null : null,
    jobCount: lookups.jobCounts.get(row.guid) ?? 0,
  };
}

export interface ContactListOptions {
  search?: string;
  /** 'active' (default), 'inactive', or 'all'. */
  active?: 'active' | 'inactive' | 'all';
}

function contactWhere(options: ContactListOptions) {
  const { search, active = 'all' } = options;
  return {
    ...(active === 'active' ? { active: 1 } : active === 'inactive' ? { active: 0 } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { id: { contains: search, mode: 'insensitive' as const } },
            { addr_email: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };
}

export async function listCustomers(
  bookGuid: string,
  options: ContactListOptions = {}
): Promise<CustomerDTO[]> {
  const rows = await prisma.customers.findMany({
    where: { ownership: { book_guid: bookGuid }, ...contactWhere(options) },
    orderBy: [{ name: 'asc' }],
  });
  const lookups = await contactLookups(rows, OWNER_TYPE_CUSTOMER);
  return rows.map(row => mapCustomer(row, lookups));
}

export async function getCustomer(bookGuid: string, guid: string): Promise<CustomerDTO | null> {
  if (!(await isEntityOwnedByBook('customer', guid, bookGuid))) return null;
  const row = await prisma.customers.findUnique({ where: { guid } });
  if (!row) return null;
  const lookups = await contactLookups([row], OWNER_TYPE_CUSTOMER);
  return mapCustomer(row, lookups);
}

/** A referenced bill term must exist AND belong to the same book. */
async function assertBilltermExists(bookGuid: string, guid: string | null | undefined): Promise<void> {
  if (!guid) return;
  const found = await prisma.billterms.findUnique({ where: { guid }, select: { guid: true } });
  if (!found || !(await isEntityOwnedByBook('billterm', guid, bookGuid))) {
    throw new BusinessValidationError(`Unknown bill terms: ${guid}`);
  }
}

/** A referenced tax table must exist AND belong to the same book. */
async function assertTaxtableExists(bookGuid: string, guid: string | null | undefined): Promise<void> {
  if (!guid) return;
  const found = await prisma.taxtables.findUnique({ where: { guid }, select: { guid: true } });
  if (!found || !(await isEntityOwnedByBook('taxtable', guid, bookGuid))) {
    throw new BusinessValidationError(`Unknown tax table: ${guid}`);
  }
}

export async function createCustomer(bookGuid: string, input: CustomerInput): Promise<CustomerDTO> {
  const [currencyGuid] = await Promise.all([
    resolveCurrencyGuid(input.currency),
    assertBilltermExists(bookGuid, input.terms),
    assertTaxtableExists(bookGuid, input.taxtable),
  ]);
  const existing = await prisma.customers.findMany({ select: { id: true } });
  const discount = percentToFraction(input.discount);
  const credit = currencyToFraction(input.credit);
  const guid = generateGuid();

  await prisma.$transaction(async tx => {
    await tx.customers.create({
      data: {
        guid,
        id: nextEntityId(existing.map(r => r.id)),
        name: input.name,
        notes: input.notes,
        active: input.active ? 1 : 0,
        discount_num: discount.num,
        discount_denom: discount.denom,
        credit_num: credit.num,
        credit_denom: credit.denom,
        currency: currencyGuid,
        tax_override: input.taxOverride ? 1 : 0,
        tax_included: input.taxIncluded ? 1 : 0,
        terms: input.terms ?? null,
        taxtable: input.taxtable ?? null,
        ...addressToColumns(input.address, 'addr'),
        ...addressToColumns(input.shipAddress, 'shipaddr'),
      },
    });
    await recordEntityOwnership('customer', guid, bookGuid, ownershipTx(tx));
  });

  await recomputeChangedRefs('billterm', input.terms);
  await recomputeChangedRefs('taxtable', input.taxtable);
  return (await getCustomer(bookGuid, guid))!;
}

export async function updateCustomer(
  bookGuid: string,
  guid: string,
  input: CustomerInput
): Promise<CustomerDTO | null> {
  if (!(await isEntityOwnedByBook('customer', guid, bookGuid))) return null;
  const existing = await prisma.customers.findUnique({ where: { guid } });
  if (!existing) return null;

  const [currencyGuid] = await Promise.all([
    resolveCurrencyGuid(input.currency),
    assertBilltermExists(bookGuid, input.terms),
    assertTaxtableExists(bookGuid, input.taxtable),
  ]);
  const discount = percentToFraction(input.discount);
  const credit = currencyToFraction(input.credit);

  await prisma.customers.update({
    where: { guid },
    data: {
      name: input.name,
      notes: input.notes,
      active: input.active ? 1 : 0,
      discount_num: discount.num,
      discount_denom: discount.denom,
      credit_num: credit.num,
      credit_denom: credit.denom,
      currency: currencyGuid,
      tax_override: input.taxOverride ? 1 : 0,
      tax_included: input.taxIncluded ? 1 : 0,
      terms: input.terms ?? null,
      taxtable: input.taxtable ?? null,
      ...addressToColumns(input.address, 'addr'),
      ...addressToColumns(input.shipAddress, 'shipaddr'),
    },
  });

  await recomputeChangedRefs('billterm', existing.terms, input.terms);
  await recomputeChangedRefs('taxtable', existing.taxtable, input.taxtable);
  return getCustomer(bookGuid, guid);
}

/** True when any jobs or invoices reference this customer. */
async function customerIsReferenced(guid: string): Promise<boolean> {
  const [jobs, invoices] = await Promise.all([
    prisma.jobs.count({ where: { owner_type: OWNER_TYPE_CUSTOMER, owner_guid: guid } }),
    prisma.invoices.count({
      where: {
        OR: [
          { owner_type: OWNER_TYPE_CUSTOMER, owner_guid: guid },
          { billto_type: OWNER_TYPE_CUSTOMER, billto_guid: guid },
        ],
      },
    }),
  ]);
  return jobs + invoices > 0;
}

export interface DeleteResult {
  /** True when the row was hard-deleted; false when it was deactivated instead. */
  deleted: boolean;
  deactivated: boolean;
}

export async function deleteCustomer(bookGuid: string, guid: string): Promise<DeleteResult | null> {
  if (!(await isEntityOwnedByBook('customer', guid, bookGuid))) return null;
  const existing = await prisma.customers.findUnique({ where: { guid } });
  if (!existing) return null;

  if (await customerIsReferenced(guid)) {
    // Deactivated, not removed — the row still belongs to this book.
    await prisma.customers.update({ where: { guid }, data: { active: 0 } });
    return { deleted: false, deactivated: true };
  }

  await prisma.$transaction(async tx => {
    await tx.customers.delete({ where: { guid } });
    await deleteEntityOwnership('customer', guid, ownershipTx(tx));
  });
  await recomputeChangedRefs('billterm', existing.terms);
  await recomputeChangedRefs('taxtable', existing.taxtable);
  return { deleted: true, deactivated: false };
}

// ============================================
// Vendors
// ============================================

type VendorRow = NonNullable<Awaited<ReturnType<typeof prisma.vendors.findUnique>>>;

function mapVendor(row: VendorRow, lookups: ContactLookups): VendorDTO {
  return {
    guid: row.guid,
    id: row.id,
    name: row.name,
    notes: row.notes,
    active: row.active === 1,
    currency: lookups.currencies.get(row.currency) ?? row.currency,
    taxOverride: row.tax_override === 1,
    // GnuCash stores vendor tax_inc as a string; desktop/XML books carry
    // upstream's uppercase YES/NO/USEGLOBAL while app-created rows use 'yes'.
    taxIncluded: row.tax_inc?.toLowerCase() === 'yes',
    address: mapAddress(row as unknown as Record<string, unknown>, 'addr'),
    terms: row.terms,
    termsName: row.terms ? lookups.termNames.get(row.terms) ?? null : null,
    taxtable: row.tax_table,
    taxtableName: row.tax_table ? lookups.taxtableNames.get(row.tax_table) ?? null : null,
    jobCount: lookups.jobCounts.get(row.guid) ?? 0,
  };
}

export async function listVendors(
  bookGuid: string,
  options: ContactListOptions = {}
): Promise<VendorDTO[]> {
  const rows = await prisma.vendors.findMany({
    where: { ownership: { book_guid: bookGuid }, ...contactWhere(options) },
    orderBy: [{ name: 'asc' }],
  });
  const lookups = await contactLookups(rows, OWNER_TYPE_VENDOR);
  return rows.map(row => mapVendor(row, lookups));
}

export async function getVendor(bookGuid: string, guid: string): Promise<VendorDTO | null> {
  if (!(await isEntityOwnedByBook('vendor', guid, bookGuid))) return null;
  const row = await prisma.vendors.findUnique({ where: { guid } });
  if (!row) return null;
  const lookups = await contactLookups([row], OWNER_TYPE_VENDOR);
  return mapVendor(row, lookups);
}

export async function createVendor(bookGuid: string, input: VendorInput): Promise<VendorDTO> {
  const [currencyGuid] = await Promise.all([
    resolveCurrencyGuid(input.currency),
    assertBilltermExists(bookGuid, input.terms),
    assertTaxtableExists(bookGuid, input.taxtable),
  ]);
  const existing = await prisma.vendors.findMany({ select: { id: true } });
  const guid = generateGuid();

  await prisma.$transaction(async tx => {
    await tx.vendors.create({
      data: {
        guid,
        id: nextEntityId(existing.map(r => r.id)),
        name: input.name,
        notes: input.notes,
        active: input.active ? 1 : 0,
        currency: currencyGuid,
        tax_override: input.taxOverride ? 1 : 0,
        tax_inc: input.taxIncluded ? 'yes' : 'no',
        terms: input.terms ?? null,
        tax_table: input.taxtable ?? null,
        ...addressToColumns(input.address, 'addr'),
      },
    });
    await recordEntityOwnership('vendor', guid, bookGuid, ownershipTx(tx));
  });

  await recomputeChangedRefs('billterm', input.terms);
  await recomputeChangedRefs('taxtable', input.taxtable);
  return (await getVendor(bookGuid, guid))!;
}

export async function updateVendor(
  bookGuid: string,
  guid: string,
  input: VendorInput
): Promise<VendorDTO | null> {
  if (!(await isEntityOwnedByBook('vendor', guid, bookGuid))) return null;
  const existing = await prisma.vendors.findUnique({ where: { guid } });
  if (!existing) return null;

  const [currencyGuid] = await Promise.all([
    resolveCurrencyGuid(input.currency),
    assertBilltermExists(bookGuid, input.terms),
    assertTaxtableExists(bookGuid, input.taxtable),
  ]);

  await prisma.vendors.update({
    where: { guid },
    data: {
      name: input.name,
      notes: input.notes,
      active: input.active ? 1 : 0,
      currency: currencyGuid,
      tax_override: input.taxOverride ? 1 : 0,
      tax_inc: input.taxIncluded ? 'yes' : 'no',
      terms: input.terms ?? null,
      tax_table: input.taxtable ?? null,
      ...addressToColumns(input.address, 'addr'),
    },
  });

  await recomputeChangedRefs('billterm', existing.terms, input.terms);
  await recomputeChangedRefs('taxtable', existing.tax_table, input.taxtable);
  return getVendor(bookGuid, guid);
}

/** True when any jobs or invoices reference this vendor. */
async function vendorIsReferenced(guid: string): Promise<boolean> {
  const [jobs, invoices] = await Promise.all([
    prisma.jobs.count({ where: { owner_type: OWNER_TYPE_VENDOR, owner_guid: guid } }),
    prisma.invoices.count({
      where: {
        OR: [
          { owner_type: OWNER_TYPE_VENDOR, owner_guid: guid },
          { billto_type: OWNER_TYPE_VENDOR, billto_guid: guid },
        ],
      },
    }),
  ]);
  return jobs + invoices > 0;
}

export async function deleteVendor(bookGuid: string, guid: string): Promise<DeleteResult | null> {
  if (!(await isEntityOwnedByBook('vendor', guid, bookGuid))) return null;
  const existing = await prisma.vendors.findUnique({ where: { guid } });
  if (!existing) return null;

  if (await vendorIsReferenced(guid)) {
    // Deactivated, not removed — the row still belongs to this book.
    await prisma.vendors.update({ where: { guid }, data: { active: 0 } });
    return { deleted: false, deactivated: true };
  }

  await prisma.$transaction(async tx => {
    await tx.vendors.delete({ where: { guid } });
    await deleteEntityOwnership('vendor', guid, ownershipTx(tx));
  });
  await recomputeChangedRefs('billterm', existing.terms);
  await recomputeChangedRefs('taxtable', existing.tax_table);
  return { deleted: true, deactivated: false };
}

// ============================================
// Jobs
// ============================================

type JobRow = NonNullable<Awaited<ReturnType<typeof prisma.jobs.findUnique>>>;

function ownerTypeToKind(ownerType: number | null): ContactKind | null {
  if (ownerType === OWNER_TYPE_CUSTOMER) return 'customer';
  if (ownerType === OWNER_TYPE_VENDOR) return 'vendor';
  return null;
}

async function jobOwnerNames(rows: JobRow[]): Promise<Map<string, string>> {
  const customerGuids = rows
    .filter(r => r.owner_type === OWNER_TYPE_CUSTOMER && r.owner_guid)
    .map(r => r.owner_guid as string);
  const vendorGuids = rows
    .filter(r => r.owner_type === OWNER_TYPE_VENDOR && r.owner_guid)
    .map(r => r.owner_guid as string);

  const [customers, vendors] = await Promise.all([
    customerGuids.length > 0
      ? prisma.customers.findMany({ where: { guid: { in: customerGuids } }, select: { guid: true, name: true } })
      : Promise.resolve([]),
    vendorGuids.length > 0
      ? prisma.vendors.findMany({ where: { guid: { in: vendorGuids } }, select: { guid: true, name: true } })
      : Promise.resolve([]),
  ]);

  return new Map([...customers, ...vendors].map(r => [r.guid, r.name]));
}

function mapJob(row: JobRow, ownerNames: Map<string, string>): JobDTO {
  return {
    guid: row.guid,
    id: row.id,
    name: row.name,
    reference: row.reference,
    active: row.active === 1,
    ownerType: ownerTypeToKind(row.owner_type),
    ownerGuid: row.owner_guid,
    ownerName: row.owner_guid ? ownerNames.get(row.owner_guid) ?? null : null,
  };
}

export interface JobListOptions extends ContactListOptions {
  ownerGuid?: string;
}

export async function listJobs(
  bookGuid: string,
  options: JobListOptions = {}
): Promise<JobDTO[]> {
  const { ownerGuid, search, active = 'all' } = options;
  const rows = await prisma.jobs.findMany({
    where: {
      ownership: { book_guid: bookGuid },
      ...(ownerGuid ? { owner_guid: ownerGuid } : {}),
      ...(active === 'active' ? { active: 1 } : active === 'inactive' ? { active: 0 } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { id: { contains: search, mode: 'insensitive' as const } },
              { reference: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    },
    orderBy: [{ name: 'asc' }],
  });
  const ownerNames = await jobOwnerNames(rows);
  return rows.map(row => mapJob(row, ownerNames));
}

export async function getJob(bookGuid: string, guid: string): Promise<JobDTO | null> {
  if (!(await isEntityOwnedByBook('job', guid, bookGuid))) return null;
  const row = await prisma.jobs.findUnique({ where: { guid } });
  if (!row) return null;
  const ownerNames = await jobOwnerNames([row]);
  return mapJob(row, ownerNames);
}

/** A job's owner must exist AND belong to the same book. */
async function assertJobOwnerExists(
  bookGuid: string,
  ownerType: ContactKind,
  ownerGuid: string
): Promise<void> {
  const owner = ownerType === 'customer'
    ? await prisma.customers.findUnique({ where: { guid: ownerGuid }, select: { guid: true } })
    : await prisma.vendors.findUnique({ where: { guid: ownerGuid }, select: { guid: true } });
  if (!owner || !(await isEntityOwnedByBook(ownerType, ownerGuid, bookGuid))) {
    throw new BusinessValidationError(`Unknown ${ownerType}: ${ownerGuid}`);
  }
}

export async function createJob(bookGuid: string, input: JobInput): Promise<JobDTO> {
  await assertJobOwnerExists(bookGuid, input.ownerType, input.ownerGuid);
  const existing = await prisma.jobs.findMany({ select: { id: true } });
  const guid = generateGuid();

  await prisma.$transaction(async tx => {
    await tx.jobs.create({
      data: {
        guid,
        id: nextEntityId(existing.map(r => r.id)),
        name: input.name,
        reference: input.reference,
        active: input.active ? 1 : 0,
        owner_type: input.ownerType === 'customer' ? OWNER_TYPE_CUSTOMER : OWNER_TYPE_VENDOR,
        owner_guid: input.ownerGuid,
      },
    });
    await recordEntityOwnership('job', guid, bookGuid, ownershipTx(tx));
  });

  return (await getJob(bookGuid, guid))!;
}

export async function updateJob(
  bookGuid: string,
  guid: string,
  input: JobInput
): Promise<JobDTO | null> {
  if (!(await isEntityOwnedByBook('job', guid, bookGuid))) return null;
  const existing = await prisma.jobs.findUnique({ where: { guid } });
  if (!existing) return null;
  await assertJobOwnerExists(bookGuid, input.ownerType, input.ownerGuid);

  await prisma.jobs.update({
    where: { guid },
    data: {
      name: input.name,
      reference: input.reference,
      active: input.active ? 1 : 0,
      owner_type: input.ownerType === 'customer' ? OWNER_TYPE_CUSTOMER : OWNER_TYPE_VENDOR,
      owner_guid: input.ownerGuid,
    },
  });

  return getJob(bookGuid, guid);
}

export async function deleteJob(bookGuid: string, guid: string): Promise<DeleteResult | null> {
  if (!(await isEntityOwnedByBook('job', guid, bookGuid))) return null;
  const existing = await prisma.jobs.findUnique({ where: { guid } });
  if (!existing) return null;

  const invoices = await prisma.invoices.count({
    where: { owner_type: OWNER_TYPE_JOB, owner_guid: guid },
  });
  if (invoices > 0) {
    // Deactivated, not removed — the row still belongs to this book.
    await prisma.jobs.update({ where: { guid }, data: { active: 0 } });
    return { deleted: false, deactivated: true };
  }

  await prisma.$transaction(async tx => {
    await tx.jobs.delete({ where: { guid } });
    await deleteEntityOwnership('job', guid, ownershipTx(tx));
  });
  return { deleted: true, deactivated: false };
}

// ============================================
// Bill terms
// ============================================

type BilltermRow = NonNullable<Awaited<ReturnType<typeof prisma.billterms.findUnique>>>;

function mapBillterm(row: BilltermRow): BilltermDTO {
  return {
    guid: row.guid,
    name: row.name,
    description: row.description,
    refcount: Number(row.refcount),
    invisible: row.invisible === 1,
    dueDays: row.duedays ?? 0,
    discountDays: row.discountdays ?? 0,
    discountPercent: fractionToNumber(row.discount_num, row.discount_denom),
  };
}

export async function listBillterms(
  bookGuid: string,
  includeInvisible = false
): Promise<BilltermDTO[]> {
  const rows = await prisma.billterms.findMany({
    where: { ownership: { book_guid: bookGuid }, ...(includeInvisible ? {} : { invisible: 0 }) },
    orderBy: [{ name: 'asc' }],
  });
  return rows.map(mapBillterm);
}

export async function createBillterm(
  bookGuid: string,
  input: BilltermInput
): Promise<BilltermDTO> {
  // Names only have to be unique within the book that owns them.
  const duplicate = await prisma.billterms.findFirst({
    where: { ownership: { book_guid: bookGuid }, name: input.name, invisible: 0 },
    select: { guid: true },
  });
  if (duplicate) {
    throw new BusinessValidationError(`Bill terms "${input.name}" already exist`);
  }

  const discount = percentToFraction(input.discountPercent);
  const guid = generateGuid();

  const row = await prisma.$transaction(async tx => {
    const created = await tx.billterms.create({
      data: {
        guid,
        name: input.name,
        description: input.description,
        refcount: 0,
        invisible: 0,
        parent: null,
        type: TERM_TYPE_DAYS,
        duedays: input.dueDays,
        discountdays: input.discountDays,
        discount_num: discount.num,
        discount_denom: discount.denom,
        cutoff: null,
      },
    });
    await recordEntityOwnership('billterm', guid, bookGuid, ownershipTx(tx));
    return created;
  });
  return mapBillterm(row);
}

export async function updateBillterm(
  bookGuid: string,
  guid: string,
  input: BilltermInput
): Promise<BilltermDTO | null> {
  if (!(await isEntityOwnedByBook('billterm', guid, bookGuid))) return null;
  const existing = await prisma.billterms.findUnique({ where: { guid } });
  if (!existing) return null;

  const duplicate = await prisma.billterms.findFirst({
    where: {
      ownership: { book_guid: bookGuid },
      guid: { not: guid },
      name: input.name,
      invisible: 0,
    },
    select: { guid: true },
  });
  if (duplicate) {
    throw new BusinessValidationError(`Bill terms "${input.name}" already exist`);
  }

  const discount = percentToFraction(input.discountPercent);
  const row = await prisma.billterms.update({
    where: { guid },
    data: {
      name: input.name,
      description: input.description,
      duedays: input.dueDays,
      discountdays: input.discountDays,
      discount_num: discount.num,
      discount_denom: discount.denom,
    },
  });
  return mapBillterm(row);
}

export async function deleteBillterm(bookGuid: string, guid: string): Promise<DeleteResult | null> {
  if (!(await isEntityOwnedByBook('billterm', guid, bookGuid))) return null;
  const existing = await prisma.billterms.findUnique({ where: { guid } });
  if (!existing) return null;

  await recomputeBilltermRefcount(guid);
  const fresh = await prisma.billterms.findUnique({ where: { guid }, select: { refcount: true } });
  if ((fresh?.refcount ?? 0) > 0) {
    // Referenced by customers/vendors/invoices: hide instead of delete
    // (GnuCash desktop behavior for in-use terms). Ownership is retained.
    await prisma.billterms.update({ where: { guid }, data: { invisible: 1 } });
    return { deleted: false, deactivated: true };
  }

  await prisma.$transaction(async tx => {
    await tx.billterms.delete({ where: { guid } });
    await deleteEntityOwnership('billterm', guid, ownershipTx(tx));
  });
  return { deleted: true, deactivated: false };
}

// ============================================
// Tax tables
// ============================================

export async function listTaxtables(
  bookGuid: string,
  includeInvisible = false
): Promise<TaxtableDTO[]> {
  const rows = await prisma.taxtables.findMany({
    where: { ownership: { book_guid: bookGuid }, ...(includeInvisible ? {} : { invisible: 0 }) },
    orderBy: [{ name: 'asc' }],
  });
  if (rows.length === 0) return [];

  const entries = await prisma.taxtable_entries.findMany({
    where: { taxtable: { in: rows.map(r => r.guid) } },
    orderBy: [{ id: 'asc' }],
  });

  const accountGuids = [...new Set(entries.map(e => e.account))];
  const accounts = accountGuids.length > 0
    ? await prisma.accounts.findMany({
        where: { guid: { in: accountGuids } },
        select: { guid: true, name: true },
      })
    : [];
  const accountNames = new Map(accounts.map(a => [a.guid, a.name]));

  return rows.map(row => ({
    guid: row.guid,
    name: row.name,
    refcount: Number(row.refcount),
    invisible: row.invisible === 1,
    entries: entries
      .filter(e => e.taxtable === row.guid)
      .map(e => ({
        id: e.id,
        account: e.account,
        accountName: accountNames.get(e.account) ?? null,
        amount: fractionToNumber(e.amount_num, e.amount_denom),
        type: e.type === AMT_TYPE_VALUE ? 'value' as const : 'percent' as const,
      })),
  }));
}

async function assertEntryAccountsExist(accountGuids: string[]): Promise<void> {
  const unique = [...new Set(accountGuids)];
  const found = await prisma.accounts.findMany({
    where: { guid: { in: unique } },
    select: { guid: true },
  });
  if (found.length !== unique.length) {
    const foundSet = new Set(found.map(a => a.guid));
    const missing = unique.find(g => !foundSet.has(g));
    throw new BusinessValidationError(`Unknown account: ${missing}`);
  }
}

function entryToRow(taxtableGuid: string, entry: z.infer<typeof taxtableEntryInputSchema>) {
  const fraction = entry.type === 'percent'
    ? percentToFraction(entry.amount)
    : currencyToFraction(entry.amount);
  return {
    taxtable: taxtableGuid,
    account: entry.account,
    amount_num: fraction.num,
    amount_denom: fraction.denom,
    type: entry.type === 'value' ? AMT_TYPE_VALUE : AMT_TYPE_PERCENT,
  };
}

export async function createTaxtable(
  bookGuid: string,
  input: TaxtableInput
): Promise<TaxtableDTO> {
  // Names only have to be unique within the book that owns them.
  const duplicate = await prisma.taxtables.findFirst({
    where: { ownership: { book_guid: bookGuid }, name: input.name, invisible: 0 },
    select: { guid: true },
  });
  if (duplicate) {
    throw new BusinessValidationError(`Tax table "${input.name}" already exists`);
  }
  await assertEntryAccountsExist(input.entries.map(e => e.account));

  const guid = generateGuid();
  await prisma.$transaction(async tx => {
    await tx.taxtables.create({
      data: { guid, name: input.name, refcount: BigInt(0), invisible: 0, parent: null },
    });
    await tx.taxtable_entries.createMany({
      data: input.entries.map(e => entryToRow(guid, e)),
    });
    await recordEntityOwnership('taxtable', guid, bookGuid, ownershipTx(tx));
  });

  const tables = await listTaxtables(bookGuid, true);
  return tables.find(t => t.guid === guid)!;
}

export async function updateTaxtable(
  bookGuid: string,
  guid: string,
  input: TaxtableInput
): Promise<TaxtableDTO | null> {
  if (!(await isEntityOwnedByBook('taxtable', guid, bookGuid))) return null;
  const existing = await prisma.taxtables.findUnique({ where: { guid } });
  if (!existing) return null;

  const duplicate = await prisma.taxtables.findFirst({
    where: {
      ownership: { book_guid: bookGuid },
      guid: { not: guid },
      name: input.name,
      invisible: 0,
    },
    select: { guid: true },
  });
  if (duplicate) {
    throw new BusinessValidationError(`Tax table "${input.name}" already exists`);
  }
  await assertEntryAccountsExist(input.entries.map(e => e.account));

  await prisma.$transaction([
    prisma.taxtables.update({ where: { guid }, data: { name: input.name } }),
    prisma.taxtable_entries.deleteMany({ where: { taxtable: guid } }),
    prisma.taxtable_entries.createMany({
      data: input.entries.map(e => entryToRow(guid, e)),
    }),
  ]);

  const tables = await listTaxtables(bookGuid, true);
  return tables.find(t => t.guid === guid) ?? null;
}

export async function deleteTaxtable(bookGuid: string, guid: string): Promise<DeleteResult | null> {
  if (!(await isEntityOwnedByBook('taxtable', guid, bookGuid))) return null;
  const existing = await prisma.taxtables.findUnique({ where: { guid } });
  if (!existing) return null;

  await recomputeTaxtableRefcount(guid);
  const fresh = await prisma.taxtables.findUnique({ where: { guid }, select: { refcount: true } });
  if (Number(fresh?.refcount ?? 0) > 0) {
    // Referenced: hide instead of delete (GnuCash desktop behavior).
    // Ownership is retained.
    await prisma.taxtables.update({ where: { guid }, data: { invisible: 1 } });
    return { deleted: false, deactivated: true };
  }

  await prisma.$transaction(async tx => {
    await tx.taxtable_entries.deleteMany({ where: { taxtable: guid } });
    await tx.taxtables.delete({ where: { guid } });
    await deleteEntityOwnership('taxtable', guid, ownershipTx(tx));
  });
  return { deleted: true, deactivated: false };
}
