import prisma from '@/lib/prisma';
import { toDecimal } from './utils';

export interface PeriodTransactionInput {
  accountGuid: string;
  startDate: string; // 'YYYY-MM-DD'
  endDate: string;   // 'YYYY-MM-DD'
  bookAccountGuids?: string[];
}

export interface PeriodTransactionRow {
  txGuid: string;
  splitGuid: string;
  date: string;        // 'YYYY-MM-DD'
  description: string;
  accountGuid: string;
  accountName: string;
  amount: number;
}

export interface PeriodTransactionResponse {
  transactions: PeriodTransactionRow[];
  total: number;
}

interface AccountRow {
  guid: string;
  name: string;
  account_type: string;
  parent_guid: string | null;
}

function collectDescendants(
  byParent: Map<string | null, AccountRow[]>,
  rootGuid: string,
  out: AccountRow[],
): void {
  const children = byParent.get(rootGuid) ?? [];
  for (const child of children) {
    out.push(child);
    collectDescendants(byParent, child.guid, out);
  }
}

function toIsoDate(d: Date): string {
  // Use UTC components so we don't drift across timezones.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function fetchPeriodTransactions(
  input: PeriodTransactionInput,
): Promise<PeriodTransactionResponse> {
  const { accountGuid, startDate, endDate, bookAccountGuids } = input;

  // 1. Fetch the candidate INCOME/EXPENSE accounts (same scope as the report itself).
  const accounts: AccountRow[] = await prisma.accounts.findMany({
    where: {
      ...(bookAccountGuids ? { guid: { in: bookAccountGuids } } : {}),
      account_type: { in: ['INCOME', 'EXPENSE'] },
      hidden: 0,
    },
    select: {
      guid: true,
      name: true,
      account_type: true,
      parent_guid: true,
    },
  });

  const byGuid = new Map(accounts.map(a => [a.guid, a]));
  const root = byGuid.get(accountGuid);
  if (!root) {
    return { transactions: [], total: 0 };
  }

  // 2. Resolve descendants in memory.
  const byParent = new Map<string | null, AccountRow[]>();
  for (const a of accounts) {
    const list = byParent.get(a.parent_guid) ?? [];
    list.push(a);
    byParent.set(a.parent_guid, list);
  }
  const inScope: AccountRow[] = [root];
  collectDescendants(byParent, root.guid, inScope);
  const inScopeGuids = inScope.map(a => a.guid);
  const nameByGuid = new Map(inScope.map(a => [a.guid, a.name]));

  // 3. Fetch every matching split.
  const rangeStart = new Date(startDate + 'T00:00:00');
  const rangeEnd = new Date(endDate + 'T23:59:59');

  const splits = await prisma.splits.findMany({
    where: {
      account_guid: { in: inScopeGuids },
      transaction: {
        post_date: { gte: rangeStart, lte: rangeEnd },
      },
    },
    select: {
      guid: true,
      tx_guid: true,
      account_guid: true,
      quantity_num: true,
      quantity_denom: true,
      transaction: {
        select: {
          post_date: true,
          enter_date: true,
          description: true,
        },
      },
    },
  });

  // 4. Shape rows. Flip sign once at the top if the clicked account is INCOME
  //    so positive numbers represent inflows (matches the report's display).
  const flip = root.account_type === 'INCOME' ? -1 : 1;

  const rows: PeriodTransactionRow[] = splits.map(s => {
    const amount = flip * toDecimal(s.quantity_num, s.quantity_denom);
    return {
      txGuid: s.tx_guid,
      splitGuid: s.guid,
      date: s.transaction.post_date ? toIsoDate(s.transaction.post_date) : '',
      description: s.transaction.description ?? '',
      accountGuid: s.account_guid,
      accountName: nameByGuid.get(s.account_guid) ?? '',
      amount,
    };
  });

  // 5. Sort by date desc; stable on tx/split guid for deterministic order in tests.
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.txGuid !== b.txGuid) return a.txGuid < b.txGuid ? -1 : 1;
    return a.splitGuid < b.splitGuid ? -1 : 1;
  });

  const total = rows.reduce((s, r) => s + r.amount, 0);
  return { transactions: rows, total };
}
