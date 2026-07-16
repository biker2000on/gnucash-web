/**
 * Customer-facing share links for invoices and estimates.
 *
 * A share row (gnucash_web_invoice_shares) maps a 48-hex-char random token to
 * one document in one book. The PUBLIC route /api/public/invoice/[token] and
 * page /share/invoice/[token] resolve the token WITHOUT a session and render a
 * read-only snapshot: header, lines, totals, amount paid/due, customer billing
 * info, and the entity's company name. Nothing else in the app is reachable
 * from a token.
 *
 * Estimates reuse the same table/route family: their reference is stored in
 * the invoice_guid column as `est:<id>` (estimates have integer ids, not
 * GUIDs), and the resolved payload is discriminated by `type`.
 *
 * Security:
 *   - tokens are 24 random bytes (crypto), hex-encoded (48 chars)
 *   - revoked or expired tokens resolve to null (indistinguishable from
 *     unknown tokens; the public page shows one neutral "expired" screen)
 *   - creation/listing/revocation are book-scoped (fetch-then-check)
 */

import { randomBytes } from 'node:crypto';
import prisma from '@/lib/prisma';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import {
  getInvoiceWithStatus,
  InvoiceNotFoundError,
  InvoiceValidationError,
  OWNER_TYPE_CUSTOMER,
  OWNER_TYPE_JOB,
  type InvoiceDetailView,
} from './invoice-engine';
import type { InvoiceStatus } from './invoice-totals';

/** Estimate references stored in the invoice_guid column: `est:<id>`. */
export const ESTIMATE_REF_PREFIX = 'est:';

/** Share tokens are exactly 48 lowercase hex characters. */
export const SHARE_TOKEN_RE = /^[0-9a-f]{48}$/;

/** Generate a fresh share token: 24 random bytes, hex-encoded. */
export function generateShareToken(): string {
  return randomBytes(24).toString('hex');
}

/** Build the `est:<id>` reference for an estimate share row. */
export function estimateShareRef(estimateId: number): string {
  return `${ESTIMATE_REF_PREFIX}${estimateId}`;
}

/** Parse an `est:<id>` reference; null when the ref is an invoice GUID. */
export function parseEstimateShareRef(ref: string): number | null {
  if (!ref.startsWith(ESTIMATE_REF_PREFIX)) return null;
  const id = parseInt(ref.slice(ESTIMATE_REF_PREFIX.length), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * True when a share row is still usable: not revoked and not past its
 * expiry (a null expires_at never expires).
 */
export function isShareActive(
  share: { revoked: boolean; expires_at: Date | null },
  now: Date = new Date(),
): boolean {
  if (share.revoked) return false;
  if (share.expires_at && share.expires_at.getTime() <= now.getTime()) return false;
  return true;
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface ShareLinkView {
  token: string;
  /** Public path (origin-relative); the client prepends its origin. */
  path: string;
  createdAt: string;
  expiresAt: string | null;
  revoked: boolean;
  active: boolean;
}

export interface PublicLineView {
  description: string;
  quantity: number;
  price: number;
  discount: number;
  tax: number;
  amount: number;
}

export interface PublicBillTo {
  name: string;
  lines: string[];
  email: string | null;
}

export interface PublicInvoiceView {
  type: 'invoice';
  companyName: string | null;
  id: string;
  status: InvoiceStatus;
  dateOpened: string | null;
  datePosted: string | null;
  dueDate: string | null;
  billingId: string | null;
  notes: string;
  currency: string;
  billTo: PublicBillTo | null;
  lines: PublicLineView[];
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  amountPaid: number;
  amountDue: number;
}

export interface PublicEstimateView {
  type: 'estimate';
  companyName: string | null;
  estimateNo: string;
  status: string;
  dateCreated: string | null;
  expires: string | null;
  notes: string | null;
  terms: string | null;
  currency: string;
  billTo: PublicBillTo | null;
  lines: PublicLineView[];
  total: number;
}

export type PublicShareView = PublicInvoiceView | PublicEstimateView;

// ---------------------------------------------------------------------------
// Book-membership check (GnuCash invoices carry no book column)
// ---------------------------------------------------------------------------

/**
 * An invoice belongs to a book when its posting account, or any of its entry
 * accounts, sits under the book's root. Draft invoices (no post_acc) are
 * checked via their entry accounts.
 */
export async function isInvoiceInBook(invoiceGuid: string, bookGuid: string): Promise<boolean> {
  const invoice = await prisma.invoices.findUnique({
    where: { guid: invoiceGuid },
    select: { guid: true, post_acc: true },
  });
  if (!invoice) return false;

  const bookAccounts = new Set(await getAccountGuidsForBook(bookGuid));
  if (invoice.post_acc && bookAccounts.has(invoice.post_acc)) return true;

  const entries = await prisma.entries.findMany({
    where: { OR: [{ invoice: invoiceGuid }, { bill: invoiceGuid }] },
    select: { i_acct: true, b_acct: true },
  });
  return entries.some(
    (e) => (e.i_acct && bookAccounts.has(e.i_acct)) || (e.b_acct && bookAccounts.has(e.b_acct)),
  );
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type ShareRow = {
  token: string;
  book_guid: string;
  invoice_guid: string;
  created_at: Date;
  expires_at: Date | null;
  revoked: boolean;
};

export function sharePath(token: string): string {
  return `/share/invoice/${token}`;
}

function rowToView(row: ShareRow, now: Date = new Date()): ShareLinkView {
  return {
    token: row.token,
    path: sharePath(row.token),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    revoked: row.revoked,
    active: isShareActive(row, now),
  };
}

// ---------------------------------------------------------------------------
// CRUD (book-scoped)
// ---------------------------------------------------------------------------

async function assertShareableInvoice(bookGuid: string, invoiceGuid: string): Promise<void> {
  const invoice = await prisma.invoices.findUnique({
    where: { guid: invoiceGuid },
    select: { guid: true, owner_type: true, owner_guid: true },
  });
  if (!invoice) throw new InvoiceNotFoundError(`Invoice not found: ${invoiceGuid}`);

  // Customer-facing links are for customer invoices only (incl. job-owned
  // documents whose job belongs to a customer).
  let effOwnerType = invoice.owner_type;
  if (invoice.owner_type === OWNER_TYPE_JOB && invoice.owner_guid) {
    const job = await prisma.jobs.findUnique({
      where: { guid: invoice.owner_guid },
      select: { owner_type: true },
    });
    effOwnerType = job?.owner_type ?? null;
  }
  if (effOwnerType !== OWNER_TYPE_CUSTOMER) {
    throw new InvoiceValidationError('Only customer invoices can be shared');
  }

  if (!(await isInvoiceInBook(invoiceGuid, bookGuid))) {
    throw new InvoiceNotFoundError(`Invoice not found: ${invoiceGuid}`);
  }
}

export async function createInvoiceShare(
  bookGuid: string,
  invoiceGuid: string,
  expiresInDays?: number | null,
): Promise<ShareLinkView> {
  await assertShareableInvoice(bookGuid, invoiceGuid);

  const expiresAt =
    expiresInDays && expiresInDays > 0
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
      : null;

  const row = await prisma.gnucash_web_invoice_shares.create({
    data: {
      token: generateShareToken(),
      book_guid: bookGuid,
      invoice_guid: invoiceGuid,
      expires_at: expiresAt,
    },
  });
  return rowToView(row);
}

export async function listInvoiceShares(
  bookGuid: string,
  invoiceGuid: string,
): Promise<ShareLinkView[]> {
  const rows = await prisma.gnucash_web_invoice_shares.findMany({
    where: { book_guid: bookGuid, invoice_guid: invoiceGuid },
    orderBy: { created_at: 'desc' },
  });
  const now = new Date();
  return rows.map((r) => rowToView(r, now));
}

/** Revoke a token. Fetch-then-check: the row must belong to the active book. */
export async function revokeInvoiceShare(bookGuid: string, token: string): Promise<void> {
  const row = await prisma.gnucash_web_invoice_shares.findUnique({ where: { token } });
  if (!row || row.book_guid !== bookGuid) {
    throw new InvoiceNotFoundError('Share link not found');
  }
  if (!row.revoked) {
    await prisma.gnucash_web_invoice_shares.update({
      where: { token },
      data: { revoked: true },
    });
  }
}

/**
 * Reuse an existing active, non-expiring share for an invoice, or create one.
 * Used by the dunning worker so reminder emails carry a stable link.
 */
export async function findOrCreateInvoiceShare(
  bookGuid: string,
  invoiceGuid: string,
): Promise<ShareLinkView> {
  const existing = await prisma.gnucash_web_invoice_shares.findFirst({
    where: { book_guid: bookGuid, invoice_guid: invoiceGuid, revoked: false, expires_at: null },
    orderBy: { created_at: 'desc' },
  });
  if (existing) return rowToView(existing);
  return createInvoiceShare(bookGuid, invoiceGuid, null);
}

/** Create a share link for an estimate (ref stored as `est:<id>`). */
export async function createEstimateShare(
  bookGuid: string,
  estimateId: number,
  expiresInDays?: number | null,
): Promise<ShareLinkView> {
  const estimate = await prisma.gnucash_web_estimates.findFirst({
    where: { id: estimateId, book_guid: bookGuid },
    select: { id: true },
  });
  if (!estimate) throw new InvoiceNotFoundError(`Estimate not found: ${estimateId}`);

  const row = await prisma.gnucash_web_invoice_shares.create({
    data: {
      token: generateShareToken(),
      book_guid: bookGuid,
      invoice_guid: estimateShareRef(estimateId),
      expires_at:
        expiresInDays && expiresInDays > 0
          ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
          : null,
    },
  });
  return rowToView(row);
}

export async function listEstimateShares(
  bookGuid: string,
  estimateId: number,
): Promise<ShareLinkView[]> {
  return listInvoiceShares(bookGuid, estimateShareRef(estimateId));
}

// ---------------------------------------------------------------------------
// Public resolution (no session)
// ---------------------------------------------------------------------------

async function companyNameForBook(bookGuid: string): Promise<string | null> {
  const profile = await prisma.gnucash_web_entity_profiles.findUnique({
    where: { book_guid: bookGuid },
    select: { entity_name: true },
  });
  return profile?.entity_name?.trim() || null;
}

function customerBillTo(customer: {
  name: string;
  addr_name: string | null;
  addr_addr1: string | null;
  addr_addr2: string | null;
  addr_addr3: string | null;
  addr_addr4: string | null;
  addr_email: string | null;
} | null): PublicBillTo | null {
  if (!customer) return null;
  return {
    name: customer.addr_name?.trim() || customer.name,
    lines: [customer.addr_addr1, customer.addr_addr2, customer.addr_addr3, customer.addr_addr4]
      .map((l) => l?.trim() ?? '')
      .filter((l) => l.length > 0),
    email: customer.addr_email?.trim() || null,
  };
}

async function currencyMnemonic(currencyGuid: string): Promise<string> {
  const c = await prisma.commodities.findUnique({
    where: { guid: currencyGuid },
    select: { mnemonic: true },
  });
  return c?.mnemonic ?? 'USD';
}

/** Resolve the END customer of an invoice (jobs resolve to their customer). */
async function endCustomerGuid(view: InvoiceDetailView): Promise<string | null> {
  if (view.ownerType === 'customer') return view.ownerGuid;
  if (view.ownerType === 'job') {
    const job = await prisma.jobs.findUnique({
      where: { guid: view.ownerGuid },
      select: { owner_type: true, owner_guid: true },
    });
    if (job?.owner_type === OWNER_TYPE_CUSTOMER && job.owner_guid) return job.owner_guid;
  }
  return null;
}

async function buildPublicInvoiceView(
  bookGuid: string,
  invoiceGuid: string,
): Promise<PublicInvoiceView | null> {
  let view: InvoiceDetailView;
  try {
    view = await getInvoiceWithStatus(invoiceGuid);
  } catch {
    return null;
  }
  if (view.type !== 'invoice') return null;

  const customerGuid = await endCustomerGuid(view);
  const customer = customerGuid
    ? await prisma.customers.findUnique({
        where: { guid: customerGuid },
        select: {
          name: true,
          addr_name: true,
          addr_addr1: true,
          addr_addr2: true,
          addr_addr3: true,
          addr_addr4: true,
          addr_email: true,
        },
      })
    : null;

  const amountPaid = view.posted
    ? Math.max(0, Math.round((view.totals.total - view.amountDue) * 100) / 100)
    : 0;

  return {
    type: 'invoice',
    companyName: await companyNameForBook(bookGuid),
    id: view.id,
    status: view.status,
    dateOpened: view.dateOpened,
    datePosted: view.datePosted,
    dueDate: view.dueDate,
    billingId: view.billingId,
    notes: view.notes,
    currency: await currencyMnemonic(view.currencyGuid),
    billTo: customerBillTo(customer),
    lines: view.entries.map((e) => ({
      description: e.description,
      quantity: e.quantity,
      price: e.price,
      discount: e.computed.discountValue,
      tax: e.computed.taxTotal,
      amount: e.computed.gross,
    })),
    subtotal: view.totals.subtotal,
    discountTotal: view.totals.discountTotal,
    taxTotal: view.totals.taxTotal,
    total: view.totals.total,
    amountPaid,
    amountDue: view.amountDue,
  };
}

async function buildPublicEstimateView(
  bookGuid: string,
  estimateId: number,
): Promise<PublicEstimateView | null> {
  const estimate = await prisma.gnucash_web_estimates.findFirst({
    where: { id: estimateId, book_guid: bookGuid },
    include: { lines: { orderBy: { sort_order: 'asc' } } },
  });
  if (!estimate) return null;

  const customer = estimate.customer_guid
    ? await prisma.customers.findUnique({
        where: { guid: estimate.customer_guid },
        select: {
          name: true,
          addr_name: true,
          addr_addr1: true,
          addr_addr2: true,
          addr_addr3: true,
          addr_addr4: true,
          addr_email: true,
        },
      })
    : null;

  const lines: PublicLineView[] = estimate.lines.map((l) => {
    const quantity = Number(l.quantity);
    const price = Number(l.unit_price);
    const amount = Math.round(quantity * price * 100) / 100;
    return {
      description: l.description ?? '',
      quantity,
      price,
      discount: 0,
      tax: 0,
      amount,
    };
  });
  const total = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;

  return {
    type: 'estimate',
    companyName: await companyNameForBook(bookGuid),
    estimateNo: estimate.estimate_no ?? `EST-${estimate.id}`,
    status: estimate.status,
    dateCreated: estimate.date_created ? estimate.date_created.toISOString().slice(0, 10) : null,
    expires: estimate.expires ? estimate.expires.toISOString().slice(0, 10) : null,
    notes: estimate.notes,
    terms: estimate.terms,
    currency: 'USD',
    billTo: customerBillTo(customer),
    lines,
    total,
  };
}

/**
 * Resolve a public share token to its document snapshot.
 * Returns null for malformed, unknown, revoked, or expired tokens — callers
 * render one neutral "unavailable" state so nothing about WHY is leaked.
 */
export async function resolveShareToken(token: string): Promise<PublicShareView | null> {
  if (typeof token !== 'string' || !SHARE_TOKEN_RE.test(token)) return null;

  const row = await prisma.gnucash_web_invoice_shares.findUnique({ where: { token } });
  if (!row || !isShareActive(row)) return null;

  const estimateId = parseEstimateShareRef(row.invoice_guid);
  if (estimateId !== null) {
    return buildPublicEstimateView(row.book_guid, estimateId);
  }
  return buildPublicInvoiceView(row.book_guid, row.invoice_guid);
}
