/**
 * Book-explicit ledger writes for owner expense reports.
 *
 * The regular transaction routes write only to the ACTIVE book. Expense
 * reports need to write to a named book (the household book while the
 * business book is active, and vice versa), so these helpers take the book
 * explicitly and re-check everything the routes check:
 *
 *   - every account belongs to that book, is not a placeholder, and is
 *     denominated in the transaction currency (so quantity = value);
 *   - the transaction balances;
 *   - a split being rewritten is not reconciled and not in a lot, and its
 *     transaction row is locked FOR UPDATE.
 *
 * They run inside the caller's Prisma transaction. Period locks, audit
 * snapshots and cache invalidation are the caller's job (before and after
 * the transaction respectively) so one report action is one audit entry per
 * ledger transaction.
 */

import prisma from '@/lib/prisma';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { generateGuid } from '@/lib/gnucash';
import type { PlannedSplit } from './model';

export class LedgerValidationError extends Error {}

export type LedgerTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export interface LoadedSplit {
  guid: string;
  txGuid: string;
  accountGuid: string;
  accountCommodityGuid: string | null;
  valueCents: number;
  memo: string;
  action: string;
  reconcileState: string;
  lotGuid: string | null;
  /** ISO YYYY-MM-DD. */
  postDate: string;
  description: string;
  currencyGuid: string;
}

/** Convert a GnuCash fraction to exact cents, or throw when it is not whole cents. */
export function fractionToCents(num: bigint, denom: bigint): number {
  if (denom === BigInt(0)) throw new LedgerValidationError('Split has a zero denominator');
  const scaled = num * BigInt(100);
  if (scaled % denom !== BigInt(0)) {
    throw new LedgerValidationError('Split amount is not a whole number of cents');
  }
  return Number(scaled / denom);
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type SplitRow = {
  guid: string;
  tx_guid: string;
  account_guid: string;
  memo: string;
  action: string;
  reconcile_state: string;
  lot_guid: string | null;
  value_num: bigint;
  value_denom: bigint;
  post_date: Date | null;
  description: string | null;
  currency_guid: string;
  commodity_guid: string | null;
};

/** Load splits and prove each is in `bookGuid`. Missing or foreign splits throw. */
export async function loadSplits(
  bookGuid: string,
  splitGuids: readonly string[],
  db: LedgerTx | typeof prisma = prisma,
): Promise<Map<string, LoadedSplit>> {
  const unique = [...new Set(splitGuids)];
  const out = new Map<string, LoadedSplit>();
  if (unique.length === 0) return out;
  const rows = await db.$queryRaw<SplitRow[]>`
    SELECT s.guid, s.tx_guid, s.account_guid, s.memo, s.action, s.reconcile_state, s.lot_guid,
           s.value_num, s.value_denom, t.post_date, t.description, t.currency_guid,
           a.commodity_guid
      FROM splits s
      JOIN transactions t ON t.guid = s.tx_guid
      JOIN accounts a ON a.guid = s.account_guid
     WHERE s.guid = ANY(${unique}::text[])
  `;
  const bookAccounts = new Set(await getAccountGuidsForBook(bookGuid));
  for (const r of rows) {
    if (!bookAccounts.has(r.account_guid)) continue;
    out.set(r.guid, {
      guid: r.guid,
      txGuid: r.tx_guid,
      accountGuid: r.account_guid,
      accountCommodityGuid: r.commodity_guid,
      valueCents: fractionToCents(BigInt(r.value_num), BigInt(r.value_denom)),
      memo: r.memo ?? '',
      action: r.action ?? '',
      reconcileState: r.reconcile_state,
      lotGuid: r.lot_guid,
      postDate: r.post_date ? isoDay(r.post_date) : '1970-01-01',
      description: r.description ?? '',
      currencyGuid: r.currency_guid,
    });
  }
  for (const guid of unique) {
    if (!out.has(guid)) throw new LedgerValidationError(`Split ${guid} was not found in this book`);
  }
  return out;
}

/**
 * Verify accounts are in the book, postable, and in `currencyGuid`. Returns
 * nothing; throws LedgerValidationError on the first problem.
 */
export async function assertPostableAccounts(
  bookGuid: string,
  accountGuids: readonly string[],
  currencyGuid: string,
  db: LedgerTx | typeof prisma = prisma,
): Promise<void> {
  const unique = [...new Set(accountGuids)];
  const bookAccounts = new Set(await getAccountGuidsForBook(bookGuid));
  const accounts = await db.accounts.findMany({
    where: { guid: { in: unique } },
    select: { guid: true, name: true, placeholder: true, commodity_guid: true },
  });
  const byGuid = new Map(accounts.map((a) => [a.guid, a]));
  for (const guid of unique) {
    const account = byGuid.get(guid);
    if (!account || !bookAccounts.has(guid)) {
      throw new LedgerValidationError('An account does not belong to this book');
    }
    if (account.placeholder) {
      throw new LedgerValidationError(`${account.name} is a placeholder account and cannot hold transactions`);
    }
    if (account.commodity_guid !== currencyGuid) {
      throw new LedgerValidationError(
        `${account.name} is not in the transaction currency; multi-currency expense reports are not supported yet`,
      );
    }
  }
}

async function lockTransaction(tx: LedgerTx, txGuid: string): Promise<void> {
  await tx.$queryRaw`SELECT guid FROM transactions WHERE guid = ${txGuid} FOR UPDATE`;
}

function centsFraction(cents: number): { num: bigint; denom: bigint } {
  return { num: BigInt(cents), denom: BigInt(100) };
}

export interface SplitPart {
  accountGuid: string;
  cents: number;
  memo?: string;
}

/**
 * Replace one split with `parts` that sum to its value. The first part keeps
 * the original split guid (so links to it survive); the rest are new splits.
 * Returns the guids in part order.
 */
export async function rewriteSplit(
  tx: LedgerTx,
  bookGuid: string,
  splitGuid: string,
  parts: readonly SplitPart[],
): Promise<string[]> {
  if (parts.length === 0) throw new LedgerValidationError('A split needs at least one part');
  const split = (await loadSplits(bookGuid, [splitGuid], tx)).get(splitGuid)!;
  await lockTransaction(tx, split.txGuid);
  // Re-read under the lock: the pre-lock read may be stale.
  const fresh = (await loadSplits(bookGuid, [splitGuid], tx)).get(splitGuid)!;
  if (fresh.reconcileState === 'y') {
    throw new LedgerValidationError('This charge is reconciled on the receivable; unreconcile it before changing it');
  }
  if (fresh.lotGuid) throw new LedgerValidationError('This charge is in a lot and cannot be split');
  const total = parts.reduce((s, p) => s + p.cents, 0);
  if (total !== fresh.valueCents) {
    throw new LedgerValidationError('The parts must add up to the original amount');
  }
  if (parts.some((p) => !Number.isInteger(p.cents) || p.cents === 0)) {
    throw new LedgerValidationError('Every part needs a non-zero amount in whole cents');
  }
  await assertPostableAccounts(bookGuid, parts.map((p) => p.accountGuid), fresh.currencyGuid, tx);

  const guids: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const { num, denom } = centsFraction(part.cents);
    const memo = part.memo ?? fresh.memo;
    if (i === 0) {
      await tx.$executeRaw`
        UPDATE splits
           SET account_guid = ${part.accountGuid}, memo = ${memo},
               value_num = ${num}, value_denom = ${denom},
               quantity_num = ${num}, quantity_denom = ${denom}
         WHERE guid = ${splitGuid}
      `;
      guids.push(splitGuid);
    } else {
      const guid = generateGuid();
      await tx.$executeRaw`
        INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date,
                            value_num, value_denom, quantity_num, quantity_denom, lot_guid)
        VALUES (${guid}, ${fresh.txGuid}, ${part.accountGuid}, ${memo}, ${fresh.action}, 'n', NULL,
                ${num}, ${denom}, ${num}, ${denom}, NULL)
      `;
      guids.push(guid);
    }
  }
  return guids;
}

/** Create a balanced transaction in `bookGuid`. Returns its guid. */
export async function createTransaction(
  tx: LedgerTx,
  input: {
    bookGuid: string;
    currencyGuid: string;
    /** ISO YYYY-MM-DD. */
    postDate: string;
    description: string;
    num?: string;
    splits: readonly PlannedSplit[];
  },
): Promise<string> {
  if (input.splits.length < 2) throw new LedgerValidationError('A transaction needs at least two splits');
  if (input.splits.reduce((s, x) => s + x.cents, 0) !== 0) {
    throw new LedgerValidationError('The transaction does not balance');
  }
  await assertPostableAccounts(input.bookGuid, input.splits.map((s) => s.accountGuid), input.currencyGuid, tx);
  const guid = generateGuid();
  const postDate = new Date(`${input.postDate}T12:00:00Z`);
  await tx.$executeRaw`
    INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
    VALUES (${guid}, ${input.currencyGuid}, ${input.num ?? ''}, ${postDate}, ${new Date()}, ${input.description})
  `;
  for (const split of input.splits) {
    const { num, denom } = centsFraction(split.cents);
    await tx.$executeRaw`
      INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date,
                          value_num, value_denom, quantity_num, quantity_denom, lot_guid)
      VALUES (${generateGuid()}, ${guid}, ${split.accountGuid}, ${split.memo}, '', 'n', NULL,
              ${num}, ${denom}, ${num}, ${denom}, NULL)
    `;
  }
  return guid;
}

/** Currency of an account (its commodity guid). */
export async function accountCurrency(accountGuid: string, db: LedgerTx | typeof prisma = prisma): Promise<string | null> {
  const account = await db.accounts.findUnique({ where: { guid: accountGuid }, select: { commodity_guid: true } });
  return account?.commodity_guid ?? null;
}
