/**
 * Contractor portal against REAL PostgreSQL and the real invoice engine.
 * The security properties are the point: a link shows ONE vendor's payments
 * from ONE book, every unusable token resolves to the same null, documents
 * are served only when attached to that vendor's payments, and views are
 * counted and audited.
 *
 * Rows are tagged with a per-run id and removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestPool } from '@/__tests__/integration/db';

const RUN = randomUUID().replace(/-/g, '').slice(0, 10);
const guid = () => randomUUID().replace(/-/g, '');
const CURRENCY = guid();
const MNEMONIC = `Y${RUN.slice(0, 6).toUpperCase()}`;
const BOOK = { book: guid(), root: guid(), template: guid() };
const OTHER = { book: guid(), root: guid(), template: guid() };
const A = { bank: guid(), card: guid(), supplies: guid(), otherBank: guid() };
let userId = 0;

let svc: typeof import('../vendor-portal.service');
let engine: typeof import('../invoice-engine');
let prisma: typeof import('@/lib/prisma').default;
let vendorA = '';
let vendorB = '';
let vendorOther = '';
let paymentA = '';
let paymentB = '';
let docA = 0;
let docB = 0;

async function postedBill(vendorGuid: string, billingId: string, amount: number, date: string) {
  const bill = await engine.createInvoice(BOOK.book, {
    ownerType: 'vendor',
    ownerGuid: vendorGuid,
    billingId,
    dateOpened: date,
    entries: [{ description: 'Work', quantity: 1, price: amount, accountGuid: A.supplies }],
  });
  await engine.postInvoice(BOOK.book, bill.guid, { postDate: date, dueDate: date });
  return bill.guid;
}

beforeAll(async () => {
  const pool = getTestPool();
  userId = (await pool.query(
    `INSERT INTO gnucash_web_users (username, auth_method) VALUES ($1, 'password') RETURNING id`,
    [`portal-itest-${RUN}`],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO commodities (guid, namespace, mnemonic, fullname, fraction, quote_flag) VALUES ($1, 'CURRENCY', $2, 'Portal test currency', 100, 0)`,
    [CURRENCY, MNEMONIC],
  );
  const acct = (g: string, name: string, type: string, parent: string | null) =>
    pool.query(
      `INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, parent_guid, code, description, hidden, placeholder)
       VALUES ($1, $2, $3, $4, 100, 0, $5, '', '', 0, 0)`,
      [g, name, type, CURRENCY, parent],
    );
  for (const b of [BOOK, OTHER]) {
    await acct(b.root, 'Root Account', 'ROOT', null);
    await acct(b.template, 'Template Root', 'ROOT', null);
    await pool.query(`INSERT INTO books (guid, root_account_guid, root_template_guid, name) VALUES ($1, $2, $3, $4)`, [
      b.book, b.root, b.template, b === BOOK ? `Payer ${RUN}` : `Other ${RUN}`,
    ]);
  }
  await acct(A.bank, 'Operating Checking 1234', 'BANK', BOOK.root);
  await acct(A.card, 'Corporate Card 9876', 'CREDIT', BOOK.root);
  await acct(A.supplies, 'Contract Labor', 'EXPENSE', BOOK.root);
  await acct(A.otherBank, 'Other Book Bank', 'BANK', OTHER.root);
  await pool.query(`INSERT INTO gnucash_web_entity_profiles (book_guid, entity_type, entity_name) VALUES ($1, 'llc_single', 'Lotus Test LLC')`, [BOOK.book]);

  svc = await import('../vendor-portal.service');
  engine = await import('../invoice-engine');
  prisma = (await import('@/lib/prisma')).default;
  const { createVendor } = await import('@/lib/services/business.service');
  const mk = async (book: string, name: string) =>
    (await createVendor(book, {
      name, notes: '', active: true, currency: MNEMONIC, taxOverride: false, taxIncluded: false, address: {},
    })).guid;
  vendorA = await mk(BOOK.book, `Contractor A ${RUN}`);
  vendorB = await mk(BOOK.book, `Contractor B ${RUN}`);
  vendorOther = await mk(OTHER.book, `Contractor Other ${RUN}`);

  const billA1 = await postedBill(vendorA, 'INV-1001', 500, '2026-09-01');
  await postedBill(vendorA, 'INV-1002', 300, '2026-09-20'); // stays open
  const billB = await postedBill(vendorB, 'B-77', 999, '2026-09-05');
  paymentA = (await engine.applyPayment(BOOK.book, {
    ownerType: 'vendor', ownerGuid: vendorA, transferAccountGuid: A.bank, amount: 500,
    date: '2026-09-10', num: 'CHK 4411', allocations: [{ invoiceGuid: billA1, amount: 500 }],
  })).transactionGuid;
  paymentB = (await engine.applyPayment(BOOK.book, {
    ownerType: 'vendor', ownerGuid: vendorB, transferAccountGuid: A.card, amount: 999,
    date: '2026-09-12', allocations: [{ invoiceGuid: billB, amount: 999 }],
  })).transactionGuid;

  // A remittance on each vendor's payment (no storage object needed for the scope check).
  const doc = async (title: string) =>
    (await pool.query(
      `INSERT INTO gnucash_web_documents (book_guid, title, storage_key, filename, mime_type, source_kind, extraction_status)
       VALUES ($1, $2, $3, $4, 'application/pdf', 'upload', 'pending') RETURNING id`,
      [BOOK.book, title, `portal-itest/${RUN}/${title}.pdf`, `${title}.pdf`],
    )).rows[0].id as number;
  docA = await doc('remittance-a');
  docB = await doc('remittance-b');
  await pool.query(
    `INSERT INTO gnucash_web_document_links (book_guid, document_id, target_type, target_id, role) VALUES ($1, $2, 'transaction', $3, 'payment_confirmation'), ($1, $4, 'transaction', $5, 'payment_confirmation')`,
    [BOOK.book, docA, paymentA, docB, paymentB],
  );
});

afterAll(async () => {
  const pool = getTestPool();
  const books = [BOOK.book, OTHER.book];
  await pool.query(`DELETE FROM gnucash_web_vendor_portal_links WHERE book_guid = ANY($1)`, [books]);
  await pool.query(`DELETE FROM gnucash_web_document_links WHERE book_guid = ANY($1)`, [books]);
  await pool.query(`DELETE FROM gnucash_web_documents WHERE book_guid = ANY($1)`, [books]);
  await pool.query(`DELETE FROM gnucash_web_audit WHERE book_guid = ANY($1)`, [books]);
  const all = await pool.query(
    `WITH RECURSIVE t AS (SELECT guid FROM accounts WHERE guid = ANY($1) UNION SELECT a.guid FROM accounts a JOIN t ON a.parent_guid = t.guid) SELECT guid FROM t`,
    [[BOOK.root, OTHER.root]],
  );
  const accounts = [...new Set([...all.rows.map((r) => r.guid), BOOK.template, OTHER.template])];
  const txs = (await pool.query(`SELECT DISTINCT tx_guid FROM splits WHERE account_guid = ANY($1)`, [accounts])).rows.map((r) => r.tx_guid);
  await pool.query(`DELETE FROM slots WHERE obj_guid = ANY($1)`, [txs]).catch(() => undefined);
  await pool.query(`DELETE FROM splits WHERE tx_guid = ANY($1)`, [txs]);
  await pool.query(`DELETE FROM transactions WHERE guid = ANY($1)`, [txs]);
  const vendors = [vendorA, vendorB, vendorOther].filter(Boolean);
  const invoices = (await pool.query(`SELECT guid FROM invoices WHERE owner_guid = ANY($1)`, [vendors])).rows.map((r) => r.guid);
  await pool.query(`DELETE FROM slots WHERE obj_guid = ANY($1)`, [invoices]).catch(() => undefined);
  await pool.query(`DELETE FROM entries WHERE bill = ANY($1)`, [invoices]).catch(() => undefined);
  await pool.query(`DELETE FROM lots WHERE account_guid = ANY($1)`, [accounts]).catch(() => undefined);
  await pool.query(`DELETE FROM invoices WHERE guid = ANY($1)`, [invoices]);
  await pool.query(`DELETE FROM gnucash_web_business_entity_ownership WHERE book_guid = ANY($1)`, [books]).catch(() => undefined);
  await pool.query(`DELETE FROM vendors WHERE guid = ANY($1)`, [vendors]);
  await pool.query(`DELETE FROM slots WHERE obj_guid = ANY($1)`, [books]).catch(() => undefined);
  await pool.query(`DELETE FROM gnucash_web_entity_profiles WHERE book_guid = ANY($1)`, [books]);
  await pool.query(`DELETE FROM books WHERE guid = ANY($1)`, [books]);
  await pool.query(`DELETE FROM accounts WHERE guid = ANY($1)`, [accounts]);
  await pool.query(`DELETE FROM commodities WHERE guid = $1`, [CURRENCY]);
  await pool.query(`DELETE FROM gnucash_web_users WHERE id = $1`, [userId]);
  await prisma?.$disconnect();
});

describe('contractor portal (real PostgreSQL)', () => {
  let tokenA = '';

  it('creates a link stored only as a hash, and audits it', async () => {
    const created = await svc.createPortalLink(BOOK.book, vendorA, { expiresInDays: 90, label: 'Q3' }, userId);
    tokenA = created.path.split('/').pop()!;
    expect(tokenA).toMatch(/^vp_[0-9a-f]{48}$/);
    const row = await prisma.gnucash_web_vendor_portal_links.findUnique({ where: { id: created.link.id } });
    expect(row!.token_hash).toBe(svc.hashPortalToken(tokenA));
    expect(JSON.stringify(row)).not.toContain(tokenA.slice(3));
    expect(created.link).toMatchObject({ active: true, viewCount: 0, label: 'Q3' });
    const audit = await prisma.gnucash_web_audit.findMany({ where: { book_guid: BOOK.book, entity_type: 'VENDOR_PORTAL' } });
    expect(audit.some((a) => a.action === 'CREATE')).toBe(true);
    // A vendor from another book cannot get a link here.
    await expect(svc.createPortalLink(BOOK.book, vendorOther, {}, userId)).rejects.toThrow(/not found/i);
  });

  it('shows only payer-side facts for this vendor', async () => {
    const resolved = await svc.resolvePortalToken(tokenA);
    expect(resolved).toMatchObject({ bookGuid: BOOK.book, vendorGuid: vendorA });
    const view = await svc.getPortalView(resolved!, new Date('2026-10-02T12:00:00Z'));
    expect(view.payerName).toBe('Lotus Test LLC');
    expect(view.payments).toHaveLength(1);
    expect(view.payments[0]).toMatchObject({
      amount: 500,
      reference: 'CHK 4411',
      method: 'Bank transfer or check',
      status: 'Sent',
      bills: [{ yourInvoiceNumber: 'INV-1001', amount: 500 }],
      documents: [{ id: docA, name: 'remittance-a' }],
    });
    expect(view.openBills).toEqual([
      expect.objectContaining({ yourInvoiceNumber: 'INV-1002', total: 300, amountDue: 300, status: 'Overdue' }),
    ]);
    // Nothing leaks: no account names, no other vendor.
    const json = JSON.stringify(view);
    for (const leak of ['Operating Checking', 'Corporate Card', 'Contract Labor', 'B-77', '999', paymentB]) {
      expect(json).not.toContain(leak);
    }
  });

  it('serves only documents attached to this vendor’s payments', async () => {
    const resolved = (await svc.resolvePortalToken(tokenA))!;
    expect(await svc.portalDocument(resolved, docA)).toMatchObject({ filename: 'remittance-a.pdf' });
    expect(await svc.portalDocument(resolved, docB)).toBeNull();
    expect(await svc.portalDocument(resolved, 2147483000)).toBeNull();
  });

  it('counts views and audits them at most hourly', async () => {
    const resolved = (await svc.resolvePortalToken(tokenA))!;
    const t0 = new Date('2026-10-02T10:00:00Z');
    await svc.recordPortalView(resolved, t0);
    await svc.recordPortalView(resolved, new Date(t0.getTime() + 60_000));
    await svc.recordPortalView(resolved, new Date(t0.getTime() + 2 * 3600_000));
    const row = await prisma.gnucash_web_vendor_portal_links.findUnique({ where: { id: resolved.linkId } });
    expect(row!.view_count).toBe(3);
    const viewed = (await prisma.gnucash_web_audit.findMany({ where: { book_guid: BOOK.book, entity_type: 'VENDOR_PORTAL', entity_guid: String(resolved.linkId) } }))
      .filter((a) => (a.new_values as { event?: string } | null)?.event === 'viewed');
    expect(viewed).toHaveLength(2);
  });

  it('resolves every unusable token to the same null', async () => {
    expect(await svc.resolvePortalToken('')).toBeNull();
    expect(await svc.resolvePortalToken('vp_nothex')).toBeNull();
    expect(await svc.resolvePortalToken(`vp_${'0'.repeat(48)}`)).toBeNull();
    expect(await svc.resolvePortalToken(`${tokenA}x`)).toBeNull();

    const expired = await svc.createPortalLink(BOOK.book, vendorB, {}, userId);
    await prisma.gnucash_web_vendor_portal_links.update({ where: { id: expired.link.id }, data: { expires_at: new Date(Date.now() - 1000) } });
    expect(await svc.resolvePortalToken(expired.path.split('/').pop()!)).toBeNull();

    const resolved = (await svc.resolvePortalToken(tokenA))!;
    await svc.revokePortalLink(BOOK.book, resolved.linkId, userId);
    expect(await svc.resolvePortalToken(tokenA)).toBeNull();
    // Revoking from another book is "not found".
    await expect(svc.revokePortalLink(OTHER.book, resolved.linkId, userId)).rejects.toThrow(/not found/i);
    const links = await svc.listPortalLinks(BOOK.book, vendorA);
    expect(links[0]).toMatchObject({ active: false, viewCount: 3 });
    expect(links[0].revokedAt).not.toBeNull();
  });

  it('flags payments without a reference for portal vendors', async () => {
    await svc.createPortalLink(BOOK.book, vendorB, { expiresInDays: 30 }, userId);
    const signals = await svc.portalSignals(BOOK.book, new Date('2026-10-02T12:00:00Z'));
    expect(signals).toContainEqual(expect.objectContaining({ kind: 'missing_reference', vendorName: `Contractor B ${RUN}`, count: 1 }));
    // Vendor A's only payment has a reference and its link is revoked: no signal.
    expect(signals.some((s) => s.vendorName === `Contractor A ${RUN}`)).toBe(false);
  });
});
