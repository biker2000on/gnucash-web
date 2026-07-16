/**
 * HSA Shoebox service — finds HSA accounts, values them, and posts
 * reimbursement transactions.
 *
 * HSA accounts are located the same way the contribution report finds
 * retirement accounts: gnucash_web_account_preferences rows with
 * is_retirement = true and retirement_account_type 'hsa' | 'hsa_family'.
 * The flagged account's whole subtree counts (cash + invested holdings
 * valued at the latest price).
 */

import prisma from '@/lib/prisma';
import { toDecimalNumber, generateGuid, fromDecimal } from '@/lib/gnucash';

const INVESTMENT_TYPES = ['STOCK', 'MUTUAL'];

export interface HsaAccountSummary {
  guid: string;
  name: string;
  fullname: string;
  retirementAccountType: string;
  /** Cash + market value of invested holdings across the subtree. */
  balance: number;
  /** Currency mnemonic of the flagged (root) HSA account. */
  currencyMnemonic: string | null;
  /** Commodity guid of the flagged account (transaction currency). */
  commodityGuid: string | null;
}

interface AccountRow {
  guid: string;
  name: string;
  fullname: string;
  account_type: string;
  parent_guid: string | null;
  commodity_guid: string | null;
  namespace: string | null;
  mnemonic: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Find HSA-flagged accounts in the book and compute each one's current
 * balance (subtree cash via split quantities + investments at latest price).
 */
export async function getHsaAccounts(bookAccountGuids: string[]): Promise<HsaAccountSummary[]> {
  if (bookAccountGuids.length === 0) return [];

  const flagged = await prisma.gnucash_web_account_preferences.findMany({
    where: {
      is_retirement: true,
      retirement_account_type: { in: ['hsa', 'hsa_family'] },
      account_guid: { in: bookAccountGuids },
    },
    select: { account_guid: true, retirement_account_type: true },
  });
  if (flagged.length === 0) return [];

  const accounts = await prisma.$queryRaw<AccountRow[]>`
    SELECT ah.guid, ah.name, ah.fullname, ah.account_type, ah.parent_guid,
           a.commodity_guid, c.namespace, c.mnemonic
    FROM account_hierarchy ah
    JOIN accounts a ON a.guid = ah.guid
    LEFT JOIN commodities c ON c.guid = a.commodity_guid
    WHERE ah.guid = ANY(${bookAccountGuids})
  `;
  const byGuid = new Map(accounts.map(a => [a.guid, a]));
  const childrenOf = new Map<string, string[]>();
  for (const a of accounts) {
    if (!a.parent_guid) continue;
    const arr = childrenOf.get(a.parent_guid) ?? [];
    arr.push(a.guid);
    childrenOf.set(a.parent_guid, arr);
  }

  const results: HsaAccountSummary[] = [];

  for (const flag of flagged) {
    const root = byGuid.get(flag.account_guid);
    if (!root) continue;

    // Collect the subtree
    const subtree: AccountRow[] = [];
    const queue = [flag.account_guid];
    while (queue.length > 0) {
      const guid = queue.pop()!;
      const acct = byGuid.get(guid);
      if (acct) subtree.push(acct);
      for (const child of childrenOf.get(guid) ?? []) queue.push(child);
    }

    const cashGuids = subtree
      .filter(a => !INVESTMENT_TYPES.includes(a.account_type) || a.namespace === 'CURRENCY')
      .map(a => a.guid);
    const investmentAccounts = subtree.filter(
      a => INVESTMENT_TYPES.includes(a.account_type) && a.namespace !== 'CURRENCY',
    );

    let balance = 0;

    if (cashGuids.length > 0) {
      const rows = await prisma.$queryRaw<Array<{ total: number | null }>>`
        SELECT SUM(s.quantity_num::numeric / NULLIF(s.quantity_denom, 0))::float8 AS total
        FROM splits s
        WHERE s.account_guid = ANY(${cashGuids})
      `;
      balance += rows[0]?.total ?? 0;
    }

    for (const inv of investmentAccounts) {
      if (!inv.commodity_guid) continue;
      const shareRows = await prisma.$queryRaw<Array<{ shares: number | null }>>`
        SELECT SUM(s.quantity_num::numeric / NULLIF(s.quantity_denom, 0))::float8 AS shares
        FROM splits s
        WHERE s.account_guid = ${inv.guid}
      `;
      const shares = shareRows[0]?.shares ?? 0;
      if (Math.abs(shares) < 1e-9) continue;
      const price = await prisma.prices.findFirst({
        where: { commodity_guid: inv.commodity_guid, value_num: { gt: 0 } },
        orderBy: { date: 'desc' },
        select: { value_num: true, value_denom: true },
      });
      if (price) {
        balance += shares * toDecimalNumber(price.value_num, price.value_denom);
      }
    }

    results.push({
      guid: root.guid,
      name: root.name,
      fullname: root.fullname,
      retirementAccountType: flag.retirement_account_type ?? 'hsa',
      balance: round2(balance),
      currencyMnemonic: root.namespace === 'CURRENCY' ? root.mnemonic : null,
      commodityGuid: root.commodity_guid,
    });
  }

  return results.sort((a, b) => b.balance - a.balance);
}

export interface ReimburseInput {
  bookGuid: string;
  bookAccountGuids: string[];
  receiptIds: number[];
  bankAccountGuid: string;
  hsaAccountGuid: string;
  /** YYYY-MM-DD */
  date: string;
}

export interface ReimburseResult {
  transactionGuid: string;
  total: number;
  receiptCount: number;
}

export class ReimburseError extends Error {
  constructor(message: string, public status: number = 400) {
    super(message);
    this.name = 'ReimburseError';
  }
}

/**
 * Post an HSA reimbursement: one GnuCash transaction moving the receipts'
 * total from the HSA account into the chosen bank account (debit bank,
 * credit HSA), then stamp every receipt with the transaction guid.
 */
export async function reimburseReceipts(input: ReimburseInput): Promise<ReimburseResult> {
  const ids = [...new Set(input.receiptIds)].filter(id => Number.isInteger(id) && id > 0);
  if (ids.length === 0) throw new ReimburseError('No receipts selected');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new ReimburseError('Invalid date');

  const bookSet = new Set(input.bookAccountGuids);
  if (!bookSet.has(input.bankAccountGuid)) {
    throw new ReimburseError('Bank account is not in the active book');
  }
  if (!bookSet.has(input.hsaAccountGuid)) {
    throw new ReimburseError('HSA account is not in the active book');
  }
  if (input.bankAccountGuid === input.hsaAccountGuid) {
    throw new ReimburseError('Bank and HSA accounts must differ');
  }

  const [bank, hsa] = await Promise.all([
    prisma.accounts.findUnique({
      where: { guid: input.bankAccountGuid },
      select: { guid: true, commodity_guid: true, commodity: { select: { namespace: true } } },
    }),
    prisma.accounts.findUnique({
      where: { guid: input.hsaAccountGuid },
      select: { guid: true, commodity_guid: true, commodity: { select: { namespace: true } } },
    }),
  ]);
  if (!bank || bank.commodity?.namespace !== 'CURRENCY' || !bank.commodity_guid) {
    throw new ReimburseError('Bank account must be a currency account');
  }
  if (!hsa || hsa.commodity?.namespace !== 'CURRENCY' || !hsa.commodity_guid) {
    throw new ReimburseError('HSA account must be a currency (cash) account');
  }
  if (bank.commodity_guid !== hsa.commodity_guid) {
    throw new ReimburseError('Bank and HSA accounts must use the same currency');
  }
  const currencyGuid = bank.commodity_guid;

  const receipts = await prisma.gnucash_web_receipts.findMany({
    where: { id: { in: ids }, book_guid: input.bookGuid },
    select: {
      id: true,
      filename: true,
      hsa_eligible: true,
      hsa_reimbursed_txn_guid: true,
      extracted_data: true,
    },
  });
  if (receipts.length !== ids.length) {
    throw new ReimburseError('One or more receipts were not found in this book', 404);
  }

  let totalCents = 0;
  for (const r of receipts) {
    if (!r.hsa_eligible) {
      throw new ReimburseError(`Receipt "${r.filename}" is not marked HSA-eligible`);
    }
    if (r.hsa_reimbursed_txn_guid) {
      throw new ReimburseError(`Receipt "${r.filename}" was already reimbursed`, 409);
    }
    const data = r.extracted_data as Record<string, unknown> | null;
    const amount = data && typeof data.amount === 'number' ? data.amount : null;
    if (amount === null || !Number.isFinite(amount) || amount <= 0) {
      throw new ReimburseError(
        `Receipt "${r.filename}" has no extracted amount — cannot include it in a reimbursement`,
      );
    }
    totalCents += Math.round(amount * 100);
  }
  const total = totalCents / 100;

  const transactionGuid = generateGuid();
  const postDate = new Date(input.date + 'T12:00:00Z');
  const enterDate = new Date();
  const description = `HSA reimbursement — ${receipts.length} receipt${receipts.length === 1 ? '' : 's'}`;
  const { num, denom } = fromDecimal(total);

  await prisma.$transaction(async tx => {
    await tx.$executeRaw`
      INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
      VALUES (${transactionGuid}, ${currencyGuid}, '', ${postDate}, ${enterDate}, ${description})
    `;

    // Debit the bank account (money in), credit the HSA (money out).
    const bankSplitGuid = generateGuid();
    await tx.$executeRaw`
      INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
      VALUES (${bankSplitGuid}, ${transactionGuid}, ${input.bankAccountGuid}, 'HSA reimbursement', '', 'n', NULL, ${num}, ${denom}, ${num}, ${denom}, NULL)
    `;
    const hsaSplitGuid = generateGuid();
    await tx.$executeRaw`
      INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
      VALUES (${hsaSplitGuid}, ${transactionGuid}, ${input.hsaAccountGuid}, 'HSA reimbursement', '', 'n', NULL, ${-num}, ${denom}, ${-num}, ${denom}, NULL)
    `;

    // Guard against a concurrent reimbursement double-stamping receipts.
    const stamped = await tx.gnucash_web_receipts.updateMany({
      where: {
        id: { in: ids },
        book_guid: input.bookGuid,
        hsa_reimbursed_txn_guid: null,
      },
      data: { hsa_reimbursed_txn_guid: transactionGuid, updated_at: new Date() },
    });
    if (stamped.count !== ids.length) {
      throw new ReimburseError('A selected receipt was reimbursed concurrently — retry', 409);
    }
  });

  return { transactionGuid, total, receiptCount: receipts.length };
}
