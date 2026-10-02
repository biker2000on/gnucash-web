/**
 * Contractor portal — a company shows ONE vendor its payments from ONE book
 * through a revocable, expiring link. The contractor has no Folio account.
 *
 * Access model (decided for v1):
 *   - A bare bearer link, like invoice share links, but with the accountant
 *     share links' storage: only the SHA-256 of the token is stored, and the
 *     secret is shown once at creation. 24 random bytes make guessing
 *     infeasible, so no second factor in v1 (an emailed one-time code would
 *     need SMTP and a vendor email; noted as a follow-up).
 *   - Unknown, malformed, revoked, expired, and out-of-scope tokens all
 *     resolve to the same null — the public page cannot tell them apart.
 *   - Every query below is scoped to the link's (book, vendor). Nothing reads
 *     account names, balances, or splits beyond each payment's amount,
 *     reference, cleared state, and the TYPE of account it was paid from
 *     ("Bank", "Card"), never which account.
 *   - Invite, revoke, and views go to the audit log (views at most hourly per
 *     link); the company sees last-opened time and view count.
 */

import { createHash, randomBytes } from 'node:crypto';
import prisma from '@/lib/prisma';
import { isEntityOwnedByBook } from '@/lib/business/entity-ownership';
import { listPayments } from '@/lib/business/invoice-engine';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { get1099Summary } from '@/lib/business/vendor-1099.service';
import { logAudit } from '@/lib/services/audit.service';
import { toDecimalNumber } from '@/lib/gnucash';

export class VendorPortalError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 = 400) {
    super(message);
  }
}

export const PORTAL_TOKEN_PREFIX = 'vp_';
const TOKEN_RE = /^vp_[0-9a-f]{48}$/;
export const PORTAL_EXPIRY_DAYS = [30, 90, 180, 365] as const;
export const DEFAULT_PORTAL_EXPIRY_DAYS = 180;
/** Minimum gap between audited view events for one link. */
const VIEW_AUDIT_INTERVAL_MS = 60 * 60 * 1000;

export function generatePortalToken(): string {
  return PORTAL_TOKEN_PREFIX + randomBytes(24).toString('hex');
}

export function hashPortalToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function portalPath(token: string): string {
  return `/share/vendor/${token}`;
}

export function normalizePortalExpiryDays(raw: unknown): number {
  const n = Number(raw);
  return (PORTAL_EXPIRY_DAYS as readonly number[]).includes(n) ? n : DEFAULT_PORTAL_EXPIRY_DAYS;
}

export interface PortalLinkView {
  id: number;
  vendorGuid: string;
  prefix: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  active: boolean;
}

type LinkRow = NonNullable<Awaited<ReturnType<typeof prisma.gnucash_web_vendor_portal_links.findFirst>>>;

export function isLinkActive(row: Pick<LinkRow, 'revoked_at' | 'expires_at'>, now = new Date()): boolean {
  return row.revoked_at === null && row.expires_at.getTime() > now.getTime();
}

function view(row: LinkRow): PortalLinkView {
  return {
    id: row.id,
    vendorGuid: row.vendor_guid,
    prefix: row.prefix,
    label: row.label,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
    lastViewedAt: row.last_viewed_at?.toISOString() ?? null,
    viewCount: row.view_count,
    active: isLinkActive(row),
  };
}

async function assertVendorInBook(bookGuid: string, vendorGuid: string): Promise<void> {
  if (!(await isEntityOwnedByBook('vendor', vendorGuid, bookGuid))) {
    throw new VendorPortalError('Vendor not found.', 404);
  }
}

/** Issue a link. The returned `token` is the only time the secret exists in clear. */
export async function createPortalLink(
  bookGuid: string,
  vendorGuid: string,
  input: { expiresInDays?: unknown; label?: string | null },
  userId: number | null,
): Promise<{ link: PortalLinkView; token: string; path: string }> {
  await assertVendorInBook(bookGuid, vendorGuid);
  const days = normalizePortalExpiryDays(input.expiresInDays);
  const token = generatePortalToken();
  const label = input.label?.trim().slice(0, 100) || null;
  const row = await prisma.gnucash_web_vendor_portal_links.create({
    data: {
      book_guid: bookGuid,
      vendor_guid: vendorGuid,
      token_hash: hashPortalToken(token),
      prefix: token.slice(0, 10),
      label,
      created_by: userId,
      expires_at: new Date(Date.now() + days * 86_400_000),
    },
  });
  await logAudit('CREATE', 'VENDOR_PORTAL', String(row.id), null, {
    vendorGuid,
    prefix: row.prefix,
    expiresAt: row.expires_at.toISOString(),
    label,
  }, { bookGuid, userId });
  return { link: view(row), token, path: portalPath(token) };
}

export async function listPortalLinks(bookGuid: string, vendorGuid: string): Promise<PortalLinkView[]> {
  await assertVendorInBook(bookGuid, vendorGuid);
  const rows = await prisma.gnucash_web_vendor_portal_links.findMany({
    where: { book_guid: bookGuid, vendor_guid: vendorGuid },
    orderBy: { created_at: 'desc' },
  });
  return rows.map(view);
}

/** All links in the book (Action Center: expiring links). */
export async function listBookPortalLinks(bookGuid: string): Promise<Array<PortalLinkView & { vendorName: string }>> {
  const rows = await prisma.gnucash_web_vendor_portal_links.findMany({
    where: { book_guid: bookGuid, revoked_at: null },
    orderBy: { expires_at: 'asc' },
  });
  if (rows.length === 0) return [];
  const vendors = await prisma.vendors.findMany({
    where: { guid: { in: [...new Set(rows.map((r) => r.vendor_guid))] } },
    select: { guid: true, name: true },
  });
  const nameOf = new Map(vendors.map((v) => [v.guid, v.name]));
  return rows.map((r) => ({ ...view(r), vendorName: nameOf.get(r.vendor_guid) ?? 'Vendor' }));
}

export async function revokePortalLink(bookGuid: string, id: number, userId: number | null): Promise<PortalLinkView> {
  const row = await prisma.gnucash_web_vendor_portal_links.findFirst({ where: { id, book_guid: bookGuid } });
  if (!row) throw new VendorPortalError('Portal link not found.', 404);
  if (row.revoked_at) return view(row);
  const updated = await prisma.gnucash_web_vendor_portal_links.update({
    where: { id },
    data: { revoked_at: new Date() },
  });
  await logAudit('UPDATE', 'VENDOR_PORTAL', String(id), { revokedAt: null }, {
    revokedAt: updated.revoked_at!.toISOString(),
    vendorGuid: row.vendor_guid,
  }, { bookGuid, userId });
  return view(updated);
}

export interface ResolvedPortal {
  linkId: number;
  bookGuid: string;
  vendorGuid: string;
  expiresAt: string;
}

/**
 * Token → (book, vendor), or null for anything that should not open: the
 * same null for malformed, unknown, revoked, expired, or a vendor no longer
 * in the book. Never throws on bad input.
 */
export async function resolvePortalToken(token: string): Promise<ResolvedPortal | null> {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const row = await prisma.gnucash_web_vendor_portal_links.findUnique({
    where: { token_hash: hashPortalToken(token) },
  });
  if (!row || !isLinkActive(row)) return null;
  if (!(await isEntityOwnedByBook('vendor', row.vendor_guid, row.book_guid))) return null;
  return { linkId: row.id, bookGuid: row.book_guid, vendorGuid: row.vendor_guid, expiresAt: row.expires_at.toISOString() };
}

/** Best effort: count the view and audit it at most hourly. Never throws. */
export async function recordPortalView(resolved: ResolvedPortal, now = new Date()): Promise<void> {
  try {
    const before = await prisma.gnucash_web_vendor_portal_links.findUnique({
      where: { id: resolved.linkId },
      select: { last_viewed_at: true },
    });
    await prisma.gnucash_web_vendor_portal_links.update({
      where: { id: resolved.linkId },
      data: { last_viewed_at: now, view_count: { increment: 1 } },
    });
    const last = before?.last_viewed_at?.getTime() ?? 0;
    if (now.getTime() - last >= VIEW_AUDIT_INTERVAL_MS) {
      await logAudit('UPDATE', 'VENDOR_PORTAL', String(resolved.linkId), null, {
        event: 'viewed',
        viewedAt: now.toISOString(),
        vendorGuid: resolved.vendorGuid,
      }, { bookGuid: resolved.bookGuid, userId: null });
    }
  } catch (error) {
    console.warn('Vendor portal view tracking failed:', error);
  }
}

/* ------------------------------------------------------------------ */
/* The contractor's view                                               */
/* ------------------------------------------------------------------ */

export type PaymentMethod = 'Bank transfer or check' | 'Card' | 'Cash' | 'Other';

/** Payer-side method from the paying account's TYPE — never its name. */
export function methodForAccountType(accountType: string | null | undefined): PaymentMethod {
  switch (accountType) {
    case 'BANK':
      return 'Bank transfer or check';
    case 'CREDIT':
      return 'Card';
    case 'CASH':
      return 'Cash';
    default:
      return 'Other';
  }
}

export interface PortalPayment {
  transactionGuid: string;
  date: string | null;
  amount: number;
  reference: string | null;
  method: PaymentMethod;
  /** Cleared by the payer's bank reconciliation, else sent. */
  status: 'Cleared' | 'Sent';
  bills: Array<{ billId: string; yourInvoiceNumber: string | null; job: string | null; amount: number }>;
  documents: Array<{ id: number; name: string }>;
}

export interface PortalBill {
  billId: string;
  yourInvoiceNumber: string | null;
  job: string | null;
  datePosted: string | null;
  dueDate: string | null;
  total: number;
  amountDue: number;
  status: 'Open' | 'Partially paid' | 'Paid' | 'Overdue';
}

export interface PortalView {
  payerName: string;
  vendorName: string;
  currency: string;
  expiresAt: string;
  payments: PortalPayment[];
  openBills: PortalBill[];
  tax1099: Array<{ year: number; totalPaid: number; reportable: boolean }>;
  w9: 'received' | 'requested' | 'missing' | 'not_needed';
}

async function payerName(bookGuid: string): Promise<string> {
  const profile = await prisma.gnucash_web_entity_profiles.findUnique({
    where: { book_guid: bookGuid },
    select: { entity_name: true },
  });
  if (profile?.entity_name) return profile.entity_name;
  const book = await prisma.books.findUnique({ where: { guid: bookGuid }, select: { name: true } });
  return book?.name ?? 'Your client';
}

/**
 * Everything the portal page shows, scoped to (book, vendor). Bills include
 * those on the vendor's own jobs, matching listPayments.
 */
export async function getPortalView(resolved: ResolvedPortal, now = new Date()): Promise<PortalView> {
  const { bookGuid, vendorGuid } = resolved;
  const [vendor, payer, payments] = await Promise.all([
    prisma.vendors.findUnique({ where: { guid: vendorGuid }, select: { name: true, currency: true } }),
    payerName(bookGuid),
    listPayments(bookGuid, 'vendor', vendorGuid),
  ]);
  const currencyRow = vendor?.currency
    ? await prisma.commodities.findUnique({ where: { guid: vendor.currency }, select: { mnemonic: true } })
    : null;

  // The vendor's bills (direct and on its jobs), with their job names.
  const jobs = await prisma.jobs.findMany({
    where: { ownership: { book_guid: bookGuid }, owner_type: 4, owner_guid: vendorGuid },
    select: { guid: true, name: true },
  });
  const jobName = new Map(jobs.map((j) => [j.guid, j.name]));
  const bills = await prisma.invoices.findMany({
    where: {
      ownership: { book_guid: bookGuid },
      OR: [
        { owner_type: 4, owner_guid: vendorGuid },
        ...(jobs.length > 0 ? [{ owner_type: 3, owner_guid: { in: jobs.map((j) => j.guid) } }] : []),
      ],
    },
    select: {
      guid: true, id: true, billing_id: true, owner_type: true, owner_guid: true,
      date_posted: true, post_lot: true, post_txn: true,
    },
  });
  const billByGuid = new Map(bills.map((b) => [b.guid, b]));
  const jobOf = (b: (typeof bills)[number]) =>
    b.owner_type === 3 && b.owner_guid ? jobName.get(b.owner_guid) ?? null : null;

  // Payment method and cleared state from the paying split (the one not in a
  // bill lot) — its account TYPE only.
  const txGuids = payments.map((p) => p.transactionGuid);
  const lotGuids = bills.map((b) => b.post_lot).filter((g): g is string => !!g);
  const payingSplits = txGuids.length
    ? await prisma.splits.findMany({
        // NULL-safe: the paying split normally has no lot, and SQL's
        // NOT (lot_guid IN …) would drop it.
        where: {
          tx_guid: { in: txGuids },
          OR: [{ lot_guid: null }, { lot_guid: { notIn: lotGuids.length ? lotGuids : ['-'] } }],
        },
        select: { tx_guid: true, reconcile_state: true, account: { select: { account_type: true } } },
      })
    : [];
  const payingByTx = new Map(payingSplits.map((s) => [s.tx_guid, s]));

  // Remittance / receipt documents attached to the payment transactions.
  const docRows = txGuids.length
    ? await prisma.$queryRaw<Array<{ target_id: string; id: number; title: string | null; filename: string }>>`
        SELECT l.target_id, d.id, d.title, d.filename
          FROM gnucash_web_document_links l
          JOIN gnucash_web_documents d ON d.id = l.document_id AND d.book_guid = l.book_guid
         WHERE l.book_guid = ${bookGuid} AND l.target_type = 'transaction'
           AND l.target_id = ANY(${txGuids}::text[])
      `.catch(() => [] as Array<{ target_id: string; id: number; title: string | null; filename: string }>)
    : [];
  const docsByTx = new Map<string, Array<{ id: number; name: string }>>();
  for (const d of docRows) {
    const list = docsByTx.get(d.target_id) ?? [];
    if (!list.some((x) => x.id === d.id)) list.push({ id: d.id, name: d.title || d.filename });
    docsByTx.set(d.target_id, list);
  }

  const portalPayments: PortalPayment[] = payments
    .map((p) => {
      const paying = payingByTx.get(p.transactionGuid);
      return {
        transactionGuid: p.transactionGuid,
        date: p.date,
        amount: p.amount,
        reference: p.num?.trim() || null,
        method: methodForAccountType(paying?.account?.account_type),
        status: paying?.reconcile_state === 'y' || paying?.reconcile_state === 'c' ? ('Cleared' as const) : ('Sent' as const),
        bills: p.allocations.map((a) => {
          const b = billByGuid.get(a.invoiceGuid);
          return {
            billId: a.invoiceId,
            yourInvoiceNumber: b?.billing_id?.trim() || null,
            job: b ? jobOf(b) : null,
            amount: a.amount,
          };
        }),
        documents: docsByTx.get(p.transactionGuid) ?? [],
      };
    })
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

  // Open bills: posted, with an amount still due (lot balance).
  const postedLots = bills.filter((b) => b.post_lot && b.post_txn);
  const lotSplits = postedLots.length
    ? await prisma.splits.findMany({
        where: { lot_guid: { in: postedLots.map((b) => b.post_lot!) } },
        select: { lot_guid: true, tx_guid: true, value_num: true, value_denom: true },
      })
    : [];
  const dueSlots = postedLots.length
    ? await prisma.slots.findMany({
        where: { obj_guid: { in: postedLots.map((b) => b.post_txn!) }, name: 'trans-date-due' },
        select: { obj_guid: true, timespec_val: true },
      })
    : [];
  const dueByTxn = new Map(dueSlots.map((s) => [s.obj_guid, s.timespec_val]));
  const today = now.toISOString().slice(0, 10);
  const openBills: PortalBill[] = [];
  for (const b of postedLots) {
    const splits = lotSplits.filter((s) => s.lot_guid === b.post_lot);
    // A/P lot: the posting split is a credit; payments are debits.
    const total = -splits.filter((s) => s.tx_guid === b.post_txn).reduce((s, x) => s + toDecimalNumber(x.value_num, x.value_denom), 0);
    const balance = -splits.reduce((s, x) => s + toDecimalNumber(x.value_num, x.value_denom), 0);
    const amountDue = Math.round(balance * 100) / 100;
    if (amountDue <= 0.004) continue;
    const due = dueByTxn.get(b.post_txn!)?.toISOString().slice(0, 10) ?? null;
    openBills.push({
      billId: b.id,
      yourInvoiceNumber: b.billing_id?.trim() || null,
      job: jobOf(b),
      datePosted: b.date_posted ? b.date_posted.toISOString().slice(0, 10) : null,
      dueDate: due,
      total: Math.round(total * 100) / 100,
      amountDue,
      status: due && due < today ? 'Overdue' : amountDue < total - 0.004 ? 'Partially paid' : 'Open',
    });
  }
  openBills.sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));

  // 1099-NEC totals (this year and last), from the 1099 report's own rules.
  const year = now.getFullYear();
  const accountGuids = await getAccountGuidsForBook(bookGuid);
  const tax1099: PortalView['tax1099'] = [];
  let w9: PortalView['w9'] = 'not_needed';
  for (const y of [year, year - 1]) {
    try {
      const summary = await get1099Summary(bookGuid, accountGuids, y);
      const row = summary.vendors.find((v) => v.vendorGuid === vendorGuid);
      if (row && row.totalPaid > 0) {
        tax1099.push({ year: y, totalPaid: row.totalPaid, reportable: row.status === 'ready' || row.status === 'missing_w9' });
        if (y === year || w9 === 'not_needed') {
          if (row.status === 'exempt') w9 = row.taxInfo?.w9Received ? 'received' : 'not_needed';
          else if (row.taxInfo?.w9Received) w9 = 'received';
          else if (row.taxInfo?.w9RequestedDate) w9 = 'requested';
          else if (row.crosses600 || row.status === 'missing_w9') w9 = 'missing';
        }
      }
    } catch (error) {
      console.warn('Vendor portal 1099 summary failed:', error);
    }
  }

  return {
    payerName: payer,
    vendorName: vendor?.name ?? 'Contractor',
    currency: currencyRow?.mnemonic ?? 'USD',
    expiresAt: resolved.expiresAt,
    payments: portalPayments,
    openBills,
    tax1099,
    w9,
  };
}

/**
 * A document the portal may serve: linked (role-agnostic) to one of THIS
 * vendor's payment transactions in THIS book. Returns its storage details,
 * or null — same null for "not yours" and "does not exist".
 */
export async function portalDocument(
  resolved: ResolvedPortal,
  documentId: number,
): Promise<{ storageKey: string; filename: string; mimeType: string | null } | null> {
  if (!Number.isInteger(documentId) || documentId <= 0) return null;
  const payments = await listPayments(resolved.bookGuid, 'vendor', resolved.vendorGuid);
  const txGuids = payments.map((p) => p.transactionGuid);
  if (txGuids.length === 0) return null;
  const rows = await prisma.$queryRaw<Array<{ storage_key: string | null; filename: string; mime_type: string | null }>>`
    SELECT d.storage_key, d.filename, d.mime_type
      FROM gnucash_web_documents d
      JOIN gnucash_web_document_links l ON l.document_id = d.id AND l.book_guid = d.book_guid
     WHERE d.id = ${documentId} AND d.book_guid = ${resolved.bookGuid}
       AND l.target_type = 'transaction' AND l.target_id = ANY(${txGuids}::text[])
     LIMIT 1
  `;
  const row = rows[0];
  if (!row?.storage_key) return null;
  return { storageKey: row.storage_key, filename: row.filename, mimeType: row.mime_type };
}

/* ------------------------------------------------------------------ */
/* Company-side signals                                                */
/* ------------------------------------------------------------------ */

export interface PortalSignal {
  key: string;
  vendorName: string;
  kind: 'expiring' | 'missing_reference';
  count: number;
  date: string | null;
}

/**
 * For the Action Center: active links expiring within 14 days, and payments
 * to portal vendors with no reference number (the contractor sees a payment
 * they cannot match to their records).
 */
export async function portalSignals(bookGuid: string, now = new Date()): Promise<PortalSignal[]> {
  const links = (await listBookPortalLinks(bookGuid)).filter((l) => l.active);
  const signals: PortalSignal[] = [];
  const soon = now.getTime() + 14 * 86_400_000;
  for (const l of links) {
    if (new Date(l.expiresAt).getTime() <= soon) {
      signals.push({ key: `vendor-portal:expiring:${l.id}`, vendorName: l.vendorName, kind: 'expiring', count: 1, date: l.expiresAt.slice(0, 10) });
    }
  }
  const since = new Date(now.getTime() - 365 * 86_400_000).toISOString().slice(0, 10);
  for (const vendorGuid of new Set(links.map((l) => l.vendorGuid))) {
    const payments = await listPayments(bookGuid, 'vendor', vendorGuid);
    const missing = payments.filter((p) => (p.date ?? '') >= since && !p.num?.trim()).length;
    if (missing > 0) {
      signals.push({
        key: `vendor-portal:reference:${vendorGuid}`,
        vendorName: links.find((l) => l.vendorGuid === vendorGuid)!.vendorName,
        kind: 'missing_reference',
        count: missing,
        date: null,
      });
    }
  }
  return signals;
}
