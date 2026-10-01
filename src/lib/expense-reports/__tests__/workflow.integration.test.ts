/**
 * Owner expense reports end to end against REAL PostgreSQL and the real
 * voucher engine: two linked books (household + single-member LLC), an
 * owner with edit on both, and the Lotus Bud workflow from TODOS.md —
 * mark, split personal, submit (partial + second report), categorize with
 * remembered payee rules, approve, recategorize, pay, settle, contribute.
 *
 * Every row is tagged by a per-run id and removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestPool } from '@/__tests__/integration/db';

const RUN = randomUUID().replace(/-/g, '').slice(0, 10);
const guid = () => randomUUID().replace(/-/g, '');

const CURRENCY = guid();
const MNEMONIC = `X${RUN.slice(0, 6).toUpperCase()}`;
const HOUSE = { book: guid(), root: guid(), template: guid() };
const BIZ = { book: guid(), root: guid(), template: guid() };
const A = {
  // household
  receivable: guid(),
  card: guid(),
  checking: guid(),
  dining: guid(),
  businessExp: guid(),
  investment: guid(),
  // business
  software: guid(),
  supplies: guid(),
  education: guid(),
  bank: guid(),
  contribution: guid(),
  uncategorized: guid(),
};
const txGuids: string[] = [];
let userId = 0;
let employeeGuid = '';

type Svc = typeof import('../household') & typeof import('../business') & typeof import('../shared');
let svc: Svc;
let prisma: typeof import('@/lib/prisma').default;
let ctx: { user: { id: number }; role: 'edit'; bookGuid: string };

async function charge(description: string, date: string, cents: number, account = A.receivable): Promise<string> {
  const pool = getTestPool();
  const tx = guid();
  const split = guid();
  txGuids.push(tx);
  await pool.query(
    `INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
     VALUES ($1, $2, '', $3::timestamp, NOW(), $4)`,
    [tx, CURRENCY, `${date} 12:00:00`, description],
  );
  await pool.query(
    `INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date,
                         value_num, value_denom, quantity_num, quantity_denom)
     VALUES ($1, $2, $3, '', '', 'n', NULL, $4, 100, $4, 100),
            ($5, $2, $6, '', '', 'n', NULL, $7, 100, $7, 100)`,
    [split, tx, account, cents, guid(), A.card, -cents],
  );
  return split;
}

async function balanceCents(accountGuid: string): Promise<number> {
  const rows = await getTestPool().query(
    `SELECT COALESCE(SUM(value_num * 100 / value_denom), 0)::bigint AS c FROM splits WHERE account_guid = $1`,
    [accountGuid],
  );
  return Number(rows.rows[0].c);
}

beforeAll(async () => {
  const pool = getTestPool();
  const user = await pool.query(
    `INSERT INTO gnucash_web_users (username, auth_method) VALUES ($1, 'password') RETURNING id`,
    [`expense-itest-${RUN}`],
  );
  userId = user.rows[0].id;
  await pool.query(
    `INSERT INTO commodities (guid, namespace, mnemonic, fullname, fraction, quote_flag)
     VALUES ($1, 'CURRENCY', $2, 'Expense report test currency', 100, 0)`,
    [CURRENCY, MNEMONIC],
  );
  const acct = (g: string, name: string, type: string, parent: string | null, placeholder = 0) =>
    pool.query(
      `INSERT INTO accounts (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu, parent_guid, code, description, hidden, placeholder)
       VALUES ($1, $2, $3, $4, 100, 0, $5, '', '', 0, $6)`,
      [g, name, type, CURRENCY, parent, placeholder],
    );
  for (const b of [HOUSE, BIZ]) {
    await acct(b.root, 'Root Account', 'ROOT', null);
    await acct(b.template, 'Template Root', 'ROOT', null);
    await pool.query(
      `INSERT INTO books (guid, root_account_guid, root_template_guid, name) VALUES ($1, $2, $3, $4)`,
      [b.book, b.root, b.template, b === HOUSE ? `Home ${RUN}` : `Lotus ${RUN}`],
    );
  }
  await acct(A.receivable, 'Reimbursable Lotus', 'RECEIVABLE', HOUSE.root);
  await acct(A.card, 'Fidelity Card', 'CREDIT', HOUSE.root);
  await acct(A.checking, 'Checking', 'BANK', HOUSE.root);
  await acct(A.dining, 'Dining', 'EXPENSE', HOUSE.root);
  await acct(A.businessExp, 'Business Lotus', 'EXPENSE', HOUSE.root);
  await acct(A.investment, 'Equity Lotus', 'EQUITY', HOUSE.root);
  await acct(A.software, 'Software & Subscriptions', 'EXPENSE', BIZ.root);
  await acct(A.supplies, 'Supplies', 'EXPENSE', BIZ.root);
  await acct(A.education, 'Continuing Education', 'EXPENSE', BIZ.root);
  await acct(A.bank, 'Bluevine Checking', 'BANK', BIZ.root);
  await acct(A.contribution, "Owner's Contributions", 'EQUITY', BIZ.root);
  await acct(A.uncategorized, 'Placeholder Group', 'EXPENSE', BIZ.root, 1);

  const role = await pool.query(`SELECT id FROM gnucash_web_roles WHERE name = 'edit'`);
  for (const b of [HOUSE.book, BIZ.book]) {
    await pool.query(`INSERT INTO gnucash_web_book_permissions (user_id, book_guid, role_id) VALUES ($1, $2, $3)`, [
      userId,
      b,
      role.rows[0].id,
    ]);
  }
  await pool.query(
    `INSERT INTO gnucash_web_book_links (business_book_guid, household_book_guid, ownership_percent) VALUES ($1, $2, 100)`,
    [BIZ.book, HOUSE.book],
  );
  await pool.query(
    `INSERT INTO gnucash_web_entity_profiles (book_guid, entity_type, entity_name) VALUES ($1, 'llc_single', 'Lotus Test'), ($2, 'household', 'Home Test')`,
    [BIZ.book, HOUSE.book],
  );

  svc = {
    ...(await import('../household')),
    ...(await import('../business')),
    ...(await import('../shared')),
  } as Svc;
  prisma = (await import('@/lib/prisma')).default;
  const { createEmployee } = await import('@/lib/business/employees.service');
  const employee = await createEmployee(BIZ.book, {
    username: `cara-${RUN}`,
    language: '',
    active: true,
    currency: MNEMONIC,
    workday: 8,
    rate: 0,
    address: { name: 'Cara (owner)' },
  });
  employeeGuid = employee.guid;
  ctx = { user: { id: userId }, role: 'edit', bookGuid: HOUSE.book };
});

afterAll(async () => {
  const pool = getTestPool();
  const books = [HOUSE.book, BIZ.book];
  const accounts = Object.values(A).concat([HOUSE.root, HOUSE.template, BIZ.root, BIZ.template]);
  await pool.query(`DELETE FROM gnucash_web_interbook_eliminations WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM gnucash_web_expense_report_lines WHERE household_book_guid = ANY($1)`, [books]);
  await pool.query(`DELETE FROM gnucash_web_expense_reports WHERE business_book_guid = ANY($1)`, [books]);
  await pool.query(`DELETE FROM gnucash_web_expense_report_settings WHERE business_book_guid = ANY($1)`, [books]);
  await pool.query(`DELETE FROM gnucash_web_categorization_rules WHERE book_guid = ANY($1)`, [books]).catch(() => undefined);
  await pool.query(`DELETE FROM gnucash_web_audit WHERE book_guid = ANY($1)`, [books]);
  // Everything the engine created lives under the two roots.
  const all = await pool.query(
    `WITH RECURSIVE t AS (SELECT guid FROM accounts WHERE guid = ANY($1)
                          UNION SELECT a.guid FROM accounts a JOIN t ON a.parent_guid = t.guid)
     SELECT guid FROM t`,
    [[HOUSE.root, BIZ.root]],
  );
  const allAccounts = [...new Set([...accounts, ...all.rows.map((r) => r.guid)])];
  const txs = await pool.query(`SELECT DISTINCT tx_guid FROM splits WHERE account_guid = ANY($1)`, [allAccounts]);
  const txList = [...new Set([...txGuids, ...txs.rows.map((r) => r.tx_guid)])];
  await pool.query(`DELETE FROM slots WHERE obj_guid = ANY($1)`, [txList]).catch(() => undefined);
  await pool.query(`DELETE FROM splits WHERE tx_guid = ANY($1)`, [txList]);
  await pool.query(`DELETE FROM transactions WHERE guid = ANY($1)`, [txList]);
  const invoices = await pool.query(`SELECT guid FROM invoices WHERE owner_guid = $1`, [employeeGuid]).catch(() => ({ rows: [] as Array<{ guid: string }> }));
  const invoiceGuids = invoices.rows.map((r) => r.guid);
  await pool.query(`DELETE FROM entries WHERE bill = ANY($1)`, [invoiceGuids]).catch(() => undefined);
  await pool.query(`DELETE FROM lots WHERE account_guid = ANY($1)`, [allAccounts]).catch(() => undefined);
  await pool.query(`DELETE FROM invoices WHERE guid = ANY($1)`, [invoiceGuids]).catch(() => undefined);
  await pool.query(`DELETE FROM gnucash_web_business_entity_ownership WHERE book_guid = ANY($1)`, [books]).catch(() => undefined);
  await pool.query(`DELETE FROM employees WHERE guid = $1`, [employeeGuid]).catch(() => undefined);
  await pool.query(`DELETE FROM slots WHERE obj_guid = ANY($1)`, [books]).catch(() => undefined);
  await pool.query(`DELETE FROM gnucash_web_documents WHERE book_guid = ANY($1)`, [books]).catch(() => undefined);
  await pool.query(`DELETE FROM gnucash_web_entity_status_history WHERE book_guid = ANY($1)`, [books]);
  await pool.query(`DELETE FROM gnucash_web_entity_profiles WHERE book_guid = ANY($1)`, [books]);
  await pool.query(`DELETE FROM gnucash_web_book_links WHERE business_book_guid = $1`, [BIZ.book]);
  await pool.query(`DELETE FROM gnucash_web_book_permissions WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM books WHERE guid = ANY($1)`, [books]);
  await pool.query(`DELETE FROM accounts WHERE guid = ANY($1)`, [allAccounts]);
  await pool.query(`DELETE FROM commodities WHERE guid = $1`, [CURRENCY]);
  await pool.query(`DELETE FROM gnucash_web_users WHERE id = $1`, [userId]);
  await prisma?.$disconnect();
});

describe('owner expense reports (real PostgreSQL)', () => {
  const S: Record<string, string> = {};

  it('validates and saves link settings', async () => {
    await expect(
      svc.saveSettings(ctx, BIZ.book, HOUSE.book, { reimbursableAccountGuid: A.dining }),
    ).rejects.toThrow(/RECEIVABLE or ASSET/);
    await expect(
      svc.saveSettings(ctx, BIZ.book, HOUSE.book, { contributionAccountGuid: A.receivable }),
    ).rejects.toThrow(/right book/);
    const saved = await svc.saveSettings(ctx, BIZ.book, HOUSE.book, {
      reimbursableAccountGuid: A.receivable,
      employeeGuid,
      contributionAccountGuid: A.contribution,
      householdInvestmentAccountGuid: A.investment,
    });
    expect(saved).toMatchObject({ reimbursableAccountGuid: A.receivable, employeeGuid, settlementMode: 'reimburse', saved: true });
  });

  it('marks an expense charge for reimbursement (preview first)', async () => {
    const split = await charge('Protrainings CPR training', '2026-08-20', 6400, A.businessExp);
    const preview = await svc.markForReimbursement(ctx, {
      householdBookGuid: HOUSE.book,
      businessBookGuid: BIZ.book,
      splitGuid: split,
      dryRun: true,
    });
    expect(preview.after).toContainEqual({ accountGuid: A.receivable, cents: 6400 });
    expect(await balanceCents(A.receivable)).toBe(0);
    await svc.markForReimbursement(ctx, { householdBookGuid: HOUSE.book, businessBookGuid: BIZ.book, splitGuid: split });
    expect(await balanceCents(A.receivable)).toBe(6400);
    expect(await balanceCents(A.businessExp)).toBe(0);
    S.cpr = split;
  });

  it('lists candidates and splits a charge between business and personal', async () => {
    S.gw = await charge('Google Workspace Lotus', '2026-09-02', 700);
    S.gn = await charge('Golden Needle Acupunct', '2026-08-03', 12047);
    S.taj = await charge('Taj Indian', '2026-09-08', 6222);
    S.herbs = await charge('Silverliningherbs', '2026-08-31', 10427);

    const preview = await svc.markPersonal(ctx, {
      householdBookGuid: HOUSE.book,
      businessBookGuid: BIZ.book,
      splitGuid: S.taj,
      cents: 2222,
      personalAccountGuid: A.dining,
      dryRun: true,
    });
    expect(preview.after).toEqual(expect.arrayContaining([
      { accountGuid: A.receivable, cents: 4000 },
      { accountGuid: A.dining, cents: 2222 },
      { accountGuid: A.card, cents: -6222 },
    ]));
    await svc.markPersonal(ctx, {
      householdBookGuid: HOUSE.book,
      businessBookGuid: BIZ.book,
      splitGuid: S.taj,
      cents: 2222,
      personalAccountGuid: A.dining,
    });
    // The rewritten household transaction still balances.
    const tajTx = await prisma.splits.findUnique({ where: { guid: S.taj }, select: { tx_guid: true } });
    const sums = await getTestPool().query(`SELECT SUM(value_num * 100 / value_denom)::bigint AS s FROM splits WHERE tx_guid = $1`, [tajTx!.tx_guid]);
    expect(Number(sums.rows[0].s)).toBe(0);

    const { candidates, unreportedCents } = await svc.listCandidates(HOUSE.book, BIZ.book);
    expect(unreportedCents).toBe(6400 + 700 + 12047 + 4000 + 10427);
    expect(candidates.find((c) => c.splitGuid === S.taj)).toMatchObject({ valueCents: 4000, remainderCents: 4000 });
  });

  it('submits a report with a partial line and refuses over-allocation', async () => {
    const first = await svc.submitReport(ctx, {
      householdBookGuid: HOUSE.book,
      businessBookGuid: BIZ.book,
      lines: [
        { splitGuid: S.cpr, cents: 6400 },
        { splitGuid: S.gw, cents: 700 },
        { splitGuid: S.gn, cents: 12047 },
        { splitGuid: S.taj, cents: 4000 },
        { splitGuid: S.herbs, cents: 5000 }, // partly allocated; finished on report 2
      ],
    });
    expect(first.report).toMatchObject({ label: 'ER-1', status: 'submitted', totalCents: 28147 });
    // Nothing is categorized yet in a fresh business book.
    expect(first.report!.lines.every((l) => l.expenseAccountGuid === null)).toBe(true);

    await expect(
      svc.submitReport(ctx, {
        householdBookGuid: HOUSE.book,
        businessBookGuid: BIZ.book,
        lines: [{ splitGuid: S.herbs, cents: 5428 }],
      }),
    ).rejects.toThrow(/Only \$54\.27/);

    const { candidates } = await svc.listCandidates(HOUSE.book, BIZ.book);
    expect(candidates.map((c) => [c.splitGuid, c.remainderCents])).toEqual([[S.herbs, 5427]]);
    const badges = await svc.splitAllocationBadges(HOUSE.book, [S.taj, S.herbs, S.gw]);
    expect(badges[S.taj]).toBe('$40.00 of $62.22 on ER-1 · $22.22 personal');
    expect(badges[S.gw]).toBe('Reported · ER-1 · Submitted');
    expect(badges[S.herbs]).toBe('$50.00 of $104.27 on ER-1 · $54.27 unreported');
    S.report1 = String(first.report!.id);
  });

  it('never over-allocates under concurrent submissions', async () => {
    const results = await Promise.allSettled([
      svc.submitReport(ctx, { householdBookGuid: HOUSE.book, businessBookGuid: BIZ.book, lines: [{ splitGuid: S.herbs, cents: 5427 }], dryRun: false }),
      svc.submitReport(ctx, { householdBookGuid: HOUSE.book, businessBookGuid: BIZ.book, lines: [{ splitGuid: S.herbs, cents: 5427 }], dryRun: false }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const won = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<Svc['submitReport']>>>;
    // Withdraw it so report 2 below can claim the remainder.
    await svc.withdrawReport(ctx, HOUSE.book, won.value.report!.id);
    const { candidates } = await svc.listCandidates(HOUSE.book, BIZ.book);
    expect(candidates.find((c) => c.splitGuid === S.herbs)?.remainderCents).toBe(5427);
  });

  it('categorizes across accounts, splits a line, remembers payees, then approves', async () => {
    const bizCtx = { ...ctx, bookGuid: BIZ.book };
    const reportId = Number(S.report1);
    const report = await svc.loadReport(reportId, BIZ.book);
    const line = (desc: string) => report.lines.find((l) => l.description.startsWith(desc))!;

    const blocked = await svc.previewApproval(bizCtx, BIZ.book, reportId);
    expect(blocked.blockers[0]).toMatch(/5 lines are still uncategorized/);
    await expect(svc.approveReport(bizCtx, BIZ.book, reportId)).rejects.toThrow(/uncategorized/);
    await expect(
      svc.updateReportLines(bizCtx, BIZ.book, reportId, [{ lineId: line('Google').id, expenseAccountGuid: A.uncategorized }]),
    ).rejects.toThrow(/placeholder/);

    await expect(
      svc.updateReportLines(bizCtx, BIZ.book, reportId, [{ lineId: line('Google').id, description: '  ' }]),
    ).rejects.toThrow(/needs a name/);
    await svc.updateReportLines(
      bizCtx,
      BIZ.book,
      reportId,
      [
        { lineId: line('Google').id, expenseAccountGuid: A.software, description: 'Google Workspace Lotus' },
        { lineId: line('Golden').id, expenseAccountGuid: A.supplies },
        { lineId: line('Silver').id, expenseAccountGuid: A.supplies },
        { lineId: line('Protrainings').id, expenseAccountGuid: A.education },
      ],
      { rememberLineIds: [line('Google').id, line('Golden').id] },
    );
    // Taj $40 → $25 supplies + $15 education.
    await svc.splitReportLine(bizCtx, BIZ.book, reportId, line('Taj').id, [
      { cents: 2500, expenseAccountGuid: A.supplies },
      { cents: 1500, expenseAccountGuid: A.education },
    ]);
    const preview = await svc.previewApproval(bizCtx, BIZ.book, reportId);
    expect(preview.blockers).toEqual([]);
    expect(preview.byAccount).toEqual(expect.arrayContaining([
      { accountGuid: A.software, cents: 700, lines: 1 },
      { accountGuid: A.supplies, cents: 12047 + 5000 + 2500, lines: 3 },
      { accountGuid: A.education, cents: 6400 + 1500, lines: 2 },
    ]));

    const approved = await svc.approveReport(bizCtx, BIZ.book, reportId, { postDate: '2026-09-30' });
    expect(approved.status).toBe('posted');
    expect(approved.voucherGuid).toBeTruthy();
    expect(await balanceCents(A.software)).toBe(700);
    expect(await balanceCents(A.supplies)).toBe(19547);
    expect(await balanceCents(A.education)).toBe(7900);
  });

  it('recategorizes a posted report by unposting and reposting', async () => {
    const bizCtx = { ...ctx, bookGuid: BIZ.book };
    const reportId = Number(S.report1);
    const report = await svc.loadReport(reportId, BIZ.book);
    const cpr = report.lines.find((l) => l.description.startsWith('Protrainings'))!;
    const dry = await svc.recategorizePostedReport(bizCtx, BIZ.book, reportId, [{ lineId: cpr.id, expenseAccountGuid: A.supplies }], { dryRun: true });
    expect(dry.byAccount.find((a) => a.accountGuid === A.supplies)?.cents).toBe(19547 + 6400);
    expect(await balanceCents(A.education)).toBe(7900);
    await svc.recategorizePostedReport(bizCtx, BIZ.book, reportId, [
      { lineId: cpr.id, expenseAccountGuid: A.supplies, description: 'CPR recertification' },
    ]);
    expect(await balanceCents(A.education)).toBe(1500);
    expect(await balanceCents(A.supplies)).toBe(19547 + 6400);
    // The rename reached both the report line and the reposted voucher entry.
    const renamed = await svc.loadReport(reportId, BIZ.book);
    expect(renamed.lines.find((l) => l.id === cpr.id)?.description).toBe('CPR recertification');
    const entry = await getTestPool().query(
      `SELECT description FROM entries WHERE bill = $1 AND description LIKE 'CPR recertification%'`,
      [renamed.voucherGuid],
    );
    expect(entry.rows).toHaveLength(1);
    // An approved line cannot go back to uncategorized.
    await expect(
      svc.recategorizePostedReport(bizCtx, BIZ.book, reportId, [{ lineId: cpr.id, expenseAccountGuid: null }]),
    ).rejects.toThrow(/needs an expense account/);
  });

  it('pays the owner and settles the household receivable', async () => {
    const bizCtx = { ...ctx, bookGuid: BIZ.book };
    const reportId = Number(S.report1);
    await expect(
      svc.settleHousehold(ctx, HOUSE.book, reportId, { depositAccountGuid: A.checking }),
    ).rejects.toThrow(/Only a paid report/);
    const paid = await svc.payReport(bizCtx, BIZ.book, reportId, { paymentAccountGuid: A.bank, date: '2026-10-05' });
    expect(paid.status).toBe('paid');
    expect(await balanceCents(A.bank)).toBe(-28147);
    await expect(
      svc.recategorizePostedReport(bizCtx, BIZ.book, reportId, [{ lineId: paid.lines[0].id, expenseAccountGuid: A.software }]),
    ).rejects.toThrow(/has been paid/);

    const settled = await svc.settleHousehold(ctx, HOUSE.book, reportId, { depositAccountGuid: A.checking, date: '2026-10-06' });
    expect(settled.action).toBe('created');
    expect(settled.report.status).toBe('settled');
    expect(await balanceCents(A.checking)).toBe(28147);
    // Receivable holds only what is still unreported (the $54.27 remainder).
    expect(await balanceCents(A.receivable)).toBe(5427);
    const elim = await getTestPool().query(
      `SELECT amount FROM gnucash_web_interbook_eliminations WHERE user_id = $1 AND left_transaction_guid = $2`,
      [userId, paid.paymentTxnGuid],
    );
    expect(Number(elim.rows[0].amount)).toBe(281.47);
    const badges = await svc.splitAllocationBadges(HOUSE.book, [S.gw]);
    expect(badges[S.gw]).toBe('Reported · ER-1 · Paid 2026-10-05');
  });

  it('pre-categorizes repeat payees on the next report and settles it as a contribution', async () => {
    await svc.saveSettings(ctx, BIZ.book, HOUSE.book, { settlementMode: 'contribution' });
    const gw2 = await charge('Google Workspace Lotus', '2026-10-02', 700);
    const gn2 = await charge('Golden Needle Acupunct', '2026-10-03', 5909);
    const second = await svc.submitReport(ctx, {
      householdBookGuid: HOUSE.book,
      businessBookGuid: BIZ.book,
      lines: [
        { splitGuid: gw2, cents: 700 },
        { splitGuid: gn2, cents: 5909 },
        { splitGuid: S.herbs, cents: 5427 },
      ],
    });
    const byDesc = (d: string) => second.report!.lines.find((l) => l.description.startsWith(d))!;
    expect(byDesc('Google')).toMatchObject({ expenseAccountGuid: A.software, categorizedBy: expect.stringMatching(/^rule:/) });
    expect(byDesc('Golden')).toMatchObject({ expenseAccountGuid: A.supplies, categorizedBy: expect.stringMatching(/^rule:/) });
    // Silverliningherbs had no rule, but payee history (report 1) knows it.
    expect(byDesc('Silver')).toMatchObject({ expenseAccountGuid: A.supplies, categorizedBy: 'history' });
    expect(second.report!.settlementMode).toBe('contribution');

    const bizCtx = { ...ctx, bookGuid: BIZ.book };
    const settled = await svc.approveReport(bizCtx, BIZ.book, second.report!.id, { postDate: '2026-10-10' });
    expect(settled.status).toBe('settled');
    expect(await balanceCents(A.contribution)).toBe(-(700 + 5909 + 5427));
    expect(await balanceCents(A.investment)).toBe(700 + 5909 + 5427);
    // Every reported charge is now off the receivable.
    expect(await balanceCents(A.receivable)).toBe(0);
    const { candidates } = await svc.listCandidates(HOUSE.book, BIZ.book);
    expect(candidates).toEqual([]);
  });

  it('enforces the accountable plan for lines dated during an S election', async () => {
    const { recordEntityStatusChange } = await import('@/lib/services/entity-status.service');
    await recordEntityStatusChange(BIZ.book, {
      effectiveFrom: '2027-01-01',
      legalForm: 'llc_single_member',
      taxClassification: 's_corp',
      electionForm: '2553',
    });
    await svc.saveSettings(ctx, BIZ.book, HOUSE.book, { settlementMode: 'reimburse' });
    const before = await charge('Acu Market', '2026-12-20', 7106);
    const after = await charge('Acu Market', '2027-01-05', 7106);
    const dry = await svc.submitReport(ctx, {
      householdBookGuid: HOUSE.book,
      businessBookGuid: BIZ.book,
      lines: [{ splitGuid: before, cents: 7106 }, { splitGuid: after, cents: 7106 }],
      dryRun: true,
    });
    expect(dry.lines.map((l) => [l.taxClassification, l.accountablePlan, l.missing])).toEqual([
      ['disregarded', false, []],
      ['s_corp', true, ['receipt', 'business_purpose']],
    ]);
    await expect(
      svc.submitReport(ctx, { householdBookGuid: HOUSE.book, businessBookGuid: BIZ.book, lines: [{ splitGuid: after, cents: 7106, businessPurpose: 'Needles' }] }),
    ).rejects.toThrow(/accountable plan/);
  });

  it('ignores charges before the report-since cutoff', async () => {
    const old = await charge('Old manually reimbursed charge', '2025-01-15', 9900);
    expect((await svc.listCandidates(HOUSE.book, BIZ.book)).candidates.some((c) => c.splitGuid === old)).toBe(true);
    await svc.saveSettings(ctx, BIZ.book, HOUSE.book, { reportSince: '2026-01-01' });
    const { candidates } = await svc.listCandidates(HOUSE.book, BIZ.book);
    expect(candidates.some((c) => c.splitGuid === old)).toBe(false);
    await expect(
      svc.submitReport(ctx, { householdBookGuid: HOUSE.book, businessBookGuid: BIZ.book, lines: [{ splitGuid: old, cents: 9900 }] }),
    ).rejects.toThrow(/before 2026-01-01/);
    const { expenseReportSignals } = await import('../insights');
    const signals = await expenseReportSignals(HOUSE.book);
    // Only the two Acu Market charges (both after the cutoff) are unreported;
    // the 2025 charge is ignored, and the receivable ties out (no drift).
    expect(signals.find((s) => s.kind === 'unreported')?.amountCents).toBe(7106 * 2);
    expect(signals.find((s) => s.kind === 'reconciliation')).toBeUndefined();
  });

  it('flags a reported charge edited below what reports claim', async () => {
    const drift = await charge('Tens unit pads', '2026-11-02', 4900);
    const submitted = await svc.submitReport(ctx, {
      householdBookGuid: HOUSE.book,
      businessBookGuid: BIZ.book,
      lines: [{ splitGuid: drift, cents: 4900 }],
    });
    const { expenseReportSignals } = await import('../insights');
    expect((await expenseReportSignals(HOUSE.book)).some((s) => s.kind === 'drift_split')).toBe(false);
    // Someone edits the charge in the ledger after reporting it.
    await getTestPool().query(`UPDATE splits SET value_num = 3000, quantity_num = 3000 WHERE guid = $1`, [drift]);
    const signals = await expenseReportSignals(HOUSE.book);
    expect(signals.find((s) => s.kind === 'drift_split')).toMatchObject({ lane: 'fix', severity: 'warning' });
    expect(signals.find((s) => s.kind === 'drift_split')?.summary).toContain(submitted.report!.label);
    // Business side sees the report awaiting categorization.
    const biz = await expenseReportSignals(BIZ.book);
    expect(biz.find((s) => s.reportId === submitted.report!.id)?.title).toMatch(/Categorize 1 line/);
    await svc.withdrawReport(ctx, HOUSE.book, submitted.report!.id);
  });

  it('settles an approved report as a capital contribution instead of paying cash', async () => {
    const bizCtx = { ...ctx, bookGuid: BIZ.book };
    const herbs = await charge('Silverliningherbs refill', '2026-11-20', 8800);
    const submitted = await svc.submitReport(ctx, {
      householdBookGuid: HOUSE.book,
      businessBookGuid: BIZ.book,
      lines: [{ splitGuid: herbs, cents: 8800 }],
    });
    const reportId = submitted.report!.id;
    await svc.updateReportLines(bizCtx, BIZ.book, reportId, [
      { lineId: submitted.report!.lines[0].id, expenseAccountGuid: A.supplies },
    ]);
    const approved = await svc.approveReport(bizCtx, BIZ.book, reportId, { postDate: '2026-11-25' });
    expect(approved).toMatchObject({ status: 'posted', settlementMode: 'reimburse' });

    const before = {
      contribution: await balanceCents(A.contribution),
      investment: await balanceCents(A.investment),
      receivable: await balanceCents(A.receivable),
      bank: await balanceCents(A.bank),
    };
    await expect(
      svc.settlePostedAsContribution(bizCtx, BIZ.book, reportId, {
        contributionAccountGuid: A.bank, // not equity
        householdInvestmentAccountGuid: A.investment,
      }),
    ).rejects.toThrow(/equity account/);

    const settled = await svc.settlePostedAsContribution(bizCtx, BIZ.book, reportId, {
      contributionAccountGuid: A.contribution,
      householdInvestmentAccountGuid: A.investment,
      date: '2026-11-30',
    });
    expect(settled).toMatchObject({ status: 'settled', settlementMode: 'contribution' });
    expect(await balanceCents(A.contribution)).toBe(before.contribution - 8800);
    expect(await balanceCents(A.investment)).toBe(before.investment + 8800);
    expect(await balanceCents(A.receivable)).toBe(before.receivable - 8800);
    expect(await balanceCents(A.bank)).toBe(before.bank); // no cash moved
    // The voucher is fully paid: nothing left owing to the owner on it.
    const { getVoucher } = await import('@/lib/business/vouchers');
    const voucher = await getVoucher(BIZ.book, settled.voucherGuid!);
    expect(Number(voucher.amountDue)).toBe(0);
    // Cannot be settled twice.
    await expect(
      svc.settlePostedAsContribution(bizCtx, BIZ.book, reportId, {
        contributionAccountGuid: A.contribution,
        householdInvestmentAccountGuid: A.investment,
      }),
    ).rejects.toThrow(/approved, unpaid/);
  });

  it('refuses users without edit on the other book', async () => {
    const pool = getTestPool();
    await pool.query(`DELETE FROM gnucash_web_book_permissions WHERE user_id = $1 AND book_guid = $2`, [userId, HOUSE.book]);
    await expect(svc.listCandidates(HOUSE.book, BIZ.book)).resolves.toBeTruthy(); // service read; routes gate reads
    await expect(
      svc.markPersonal(ctx, { householdBookGuid: HOUSE.book, businessBookGuid: BIZ.book, splitGuid: S.gw, cents: 1, personalAccountGuid: A.dining }),
    ).rejects.toThrow(/edit access to the household book/);
  });
});
