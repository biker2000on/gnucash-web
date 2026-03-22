/**
 * Lot Assignment Service
 *
 * Implements auto-assign algorithms (FIFO, LIFO, average) and
 * bulk operations (clear-assign, scrub-all, revert) for lot management.
 *
 * Uses the scrub engine from lot-scrub.ts for sell splitting,
 * transfer linking, and capital gains generation.
 */

import prisma from './prisma';
import { generateGuid, toDecimalNumber } from './gnucash';
import {
  splitSellAcrossLots,
  linkTransferToLot,
  generateCapitalGains,
  type OpenLot,
  type PrismaTx,
} from './lot-scrub';

interface SplitForAssignment {
  guid: string;
  tx_guid: string;
  account_guid: string;
  quantity_num: bigint;
  quantity_denom: bigint;
  value_num: bigint;
  value_denom: bigint;
  post_date: Date | null;
  lot_guid: string | null;
}

export interface AutoAssignResult {
  lotsCreated: number;
  splitsAssigned: number;
  splitsCreated: number;
  gainsTransactions: number;
  totalRealizedGain: number;
  method: string;
  runId: string;
  warnings: string[];
}

async function getUnassignedSplits(
  accountGuid: string,
  tx: PrismaTx
): Promise<SplitForAssignment[]> {
  const splits = await tx.splits.findMany({
    where: {
      account_guid: accountGuid,
      lot_guid: null,
    },
    include: {
      transaction: {
        select: { post_date: true },
      },
    },
    orderBy: { transaction: { post_date: 'asc' } },
  });

  return splits.map(s => ({
    guid: s.guid,
    tx_guid: s.tx_guid,
    account_guid: s.account_guid,
    quantity_num: s.quantity_num,
    quantity_denom: s.quantity_denom,
    value_num: s.value_num,
    value_denom: s.value_denom,
    post_date: s.transaction?.post_date ?? null,
    lot_guid: s.lot_guid,
  }));
}

async function createLot(
  accountGuid: string,
  title: string,
  runId: string,
  tx: PrismaTx
): Promise<string> {
  const guid = generateGuid();
  await tx.lots.create({
    data: {
      guid,
      account_guid: accountGuid,
      is_closed: 0,
    },
  });
  await tx.slots.create({
    data: {
      obj_guid: guid,
      name: 'title',
      slot_type: 4,
      string_val: title,
    },
  });
  await tx.slots.create({
    data: {
      obj_guid: guid,
      name: 'gnucash_web_generated',
      slot_type: 4,
      string_val: runId,
    },
  });
  return guid;
}

async function assignWithStrategy(
  accountGuid: string,
  tx: PrismaTx,
  strategy: 'fifo' | 'lifo'
): Promise<AutoAssignResult> {
  const runId = generateGuid();
  const warnings: string[] = [];

  // Fetch account commodity_guid for transfer detection
  const account = await tx.accounts.findUnique({
    where: { guid: accountGuid },
    select: { commodity_guid: true },
  });
  if (!account) {
    throw new Error(`Account not found: ${accountGuid}`);
  }

  const splits = await getUnassignedSplits(accountGuid, tx);
  if (splits.length === 0) {
    return {
      lotsCreated: 0, splitsAssigned: 0, splitsCreated: 0,
      gainsTransactions: 0, totalRealizedGain: 0,
      method: strategy, runId, warnings,
    };
  }

  // Classify splits: transfers-in, buys, sells
  const transferIns: SplitForAssignment[] = [];
  const buys: SplitForAssignment[] = [];
  const sells: SplitForAssignment[] = [];

  for (const s of splits) {
    const qty = toDecimalNumber(s.quantity_num, s.quantity_denom);
    if (qty < 0) {
      sells.push(s);
      continue;
    }
    if (qty > 0) {
      // Check if this is a transfer-in: same transaction has a negative-qty split
      // from another account with the same commodity
      const txSplits = await tx.splits.findMany({
        where: { tx_guid: s.tx_guid },
        include: {
          account: { select: { guid: true, commodity_guid: true, account_type: true } },
        },
      });
      const matchingSend = txSplits.find(
        ts =>
          ts.account_guid !== accountGuid &&
          ts.account?.commodity_guid === account.commodity_guid &&
          ts.account?.account_type !== 'TRADING' &&
          toDecimalNumber(ts.quantity_num, ts.quantity_denom) < 0
      );
      if (matchingSend) {
        transferIns.push(s);
      } else {
        buys.push(s);
      }
    }
  }

  buys.sort((a, b) => (a.post_date?.getTime() || 0) - (b.post_date?.getTime() || 0));

  let lotsCreated = 0;
  let splitsCreated = 0;

  // Load existing open lots
  const existingLots = await tx.lots.findMany({
    where: { account_guid: accountGuid, is_closed: 0 },
    include: {
      splits: {
        select: { quantity_num: true, quantity_denom: true },
      },
    },
  });

  // Build openLots array
  const openLots: OpenLot[] = [];

  for (const lot of existingLots) {
    const shares = lot.splits.reduce(
      (sum, s) => sum + toDecimalNumber(s.quantity_num, s.quantity_denom), 0
    );
    if (shares > 0.0001) {
      // Get the earliest split date for the lot
      const lotSplits = await tx.splits.findMany({
        where: { lot_guid: lot.guid },
        include: { transaction: { select: { post_date: true } } },
        orderBy: { transaction: { post_date: 'asc' } },
        take: 1,
      });
      const openDate = lotSplits[0]?.transaction?.post_date ?? null;
      openLots.push({ guid: lot.guid, shares, openDate });
    }
  }

  // Process transfer-ins first (they create new lots via linkTransferToLot)
  for (const transfer of transferIns) {
    const result = await linkTransferToLot(transfer.guid, runId, tx);
    if (result.created) {
      lotsCreated++;
      // Add the new lot to openLots
      const qty = toDecimalNumber(transfer.quantity_num, transfer.quantity_denom);
      openLots.push({ guid: result.lotGuid, shares: qty, openDate: transfer.post_date });
    } else {
      // Already assigned — update openLots if the lot exists
      const existingIdx = openLots.findIndex(l => l.guid === result.lotGuid);
      if (existingIdx >= 0) {
        // shares already counted from existing lots
      } else {
        const qty = toDecimalNumber(transfer.quantity_num, transfer.quantity_denom);
        openLots.push({ guid: result.lotGuid, shares: qty, openDate: transfer.post_date });
      }
    }
  }

  // Process buys — each buy creates a new lot
  for (const buy of buys) {
    const dateStr = buy.post_date
      ? buy.post_date.toISOString().split('T')[0]
      : 'Unknown';
    const title = `Buy ${dateStr}`;
    const lotGuid = await createLot(accountGuid, title, runId, tx);
    lotsCreated++;

    await tx.splits.update({
      where: { guid: buy.guid },
      data: { lot_guid: lotGuid },
    });

    const qty = toDecimalNumber(buy.quantity_num, buy.quantity_denom);
    openLots.push({ guid: lotGuid, shares: qty, openDate: buy.post_date });
  }

  // Sort openLots by date for FIFO, reverse for LIFO
  openLots.sort((a, b) => (a.openDate?.getTime() || 0) - (b.openDate?.getTime() || 0));
  const searchOrder = strategy === 'lifo' ? [...openLots].reverse() : openLots;

  // Process sells using scrub engine
  for (const sell of sells) {
    const result = await splitSellAcrossLots(sell.guid, searchOrder, runId, tx);
    splitsCreated += result.subSplitsCreated.length;
    if (result.warning) {
      warnings.push(result.warning);
    }
  }

  // Generate capital gains for lots that are now closed (shares ~= 0)
  let gainsTransactions = 0;
  let totalRealizedGain = 0;

  for (const lot of openLots) {
    if (Math.abs(lot.shares) < 0.0001) {
      const gainsResult = await generateCapitalGains(lot.guid, runId, tx);
      if (gainsResult.gainsTransactionGuid) {
        gainsTransactions++;
        splitsCreated += 2; // invest split + income split
      }
      totalRealizedGain += gainsResult.gainLoss;
      if (gainsResult.skippedReason) {
        warnings.push(`Lot ${lot.guid.substring(0, 8)}: ${gainsResult.skippedReason}`);
      }
    }
  }

  const splitsAssigned = transferIns.length + buys.length + sells.length;

  return {
    lotsCreated,
    splitsAssigned,
    splitsCreated,
    gainsTransactions,
    totalRealizedGain,
    method: strategy,
    runId,
    warnings,
  };
}

async function assignFIFO(
  accountGuid: string,
  tx: PrismaTx
): Promise<AutoAssignResult> {
  return assignWithStrategy(accountGuid, tx, 'fifo');
}

async function assignLIFO(
  accountGuid: string,
  tx: PrismaTx
): Promise<AutoAssignResult> {
  return assignWithStrategy(accountGuid, tx, 'lifo');
}

async function assignAverage(
  accountGuid: string,
  tx: PrismaTx
): Promise<AutoAssignResult> {
  // Average method: each buy gets its own lot (same as FIFO for lot creation).
  // Sells go to the earliest lot (same allocation as FIFO).
  // The difference is in *display*: the UI shows averaged cost per share.
  return assignFIFO(accountGuid, tx);
}

export async function autoAssignLots(
  accountGuid: string,
  method: 'fifo' | 'lifo' | 'average'
): Promise<AutoAssignResult> {
  return prisma.$transaction(async (tx) => {
    switch (method) {
      case 'fifo':
        return assignFIFO(accountGuid, tx);
      case 'lifo':
        return assignLIFO(accountGuid, tx);
      case 'average':
        return assignAverage(accountGuid, tx);
      default:
        throw new Error(`Unknown assignment method: ${method}`);
    }
  });
}

export async function clearLotAssignments(
  accountGuid: string
): Promise<{ splitsUnassigned: number; lotsDeleted: number }> {
  return prisma.$transaction(async (tx) => {
    // 1. Find and delete auto-generated sub-splits and gains transactions

    // Find all lots for this account
    const accountLots = await tx.lots.findMany({
      where: { account_guid: accountGuid },
      select: { guid: true },
    });
    const lotGuids = accountLots.map(l => l.guid);

    // Find splits in this account tagged with gnucash_web_generated
    const taggedSplitSlots = await tx.slots.findMany({
      where: {
        name: 'gnucash_web_generated',
        obj_guid: {
          in: (await tx.splits.findMany({
            where: { account_guid: accountGuid },
            select: { guid: true },
          })).map(s => s.guid),
        },
      },
      select: { obj_guid: true, string_val: true },
    });
    const taggedSplitGuids = taggedSplitSlots.map(s => s.obj_guid);

    // Find splits that have original_quantity_num slot (were modified by sell splitting)
    const originalQtySlots = await tx.slots.findMany({
      where: {
        name: 'original_quantity_num',
        obj_guid: {
          in: (await tx.splits.findMany({
            where: { account_guid: accountGuid },
            select: { guid: true },
          })).map(s => s.guid),
        },
      },
      select: { obj_guid: true, string_val: true },
    });

    // Restore original sell splits
    for (const slot of originalQtySlots) {
      const denomSlot = await tx.slots.findFirst({
        where: { obj_guid: slot.obj_guid, name: 'original_quantity_denom' },
      });
      const valNumSlot = await tx.slots.findFirst({
        where: { obj_guid: slot.obj_guid, name: 'original_value_num' },
      });
      const valDenomSlot = await tx.slots.findFirst({
        where: { obj_guid: slot.obj_guid, name: 'original_value_denom' },
      });

      if (slot.string_val && denomSlot?.string_val && valNumSlot?.string_val && valDenomSlot?.string_val) {
        await tx.splits.update({
          where: { guid: slot.obj_guid },
          data: {
            quantity_num: BigInt(slot.string_val),
            quantity_denom: BigInt(denomSlot.string_val),
            value_num: BigInt(valNumSlot.string_val),
            value_denom: BigInt(valDenomSlot.string_val),
            lot_guid: null,
          },
        });
      }

      // Clean up original value slots
      await tx.slots.deleteMany({
        where: {
          obj_guid: slot.obj_guid,
          name: { in: ['original_quantity_num', 'original_quantity_denom', 'original_value_num', 'original_value_denom', 'gnucash_web_generated'] },
        },
      });
    }

    // Find gains transactions: transactions where ALL splits are tagged with gnucash_web_generated
    // First, get all transactions that have at least one tagged split in this account
    const taggedSplitsInAccount = await tx.splits.findMany({
      where: { guid: { in: taggedSplitGuids } },
      select: { tx_guid: true, guid: true },
    });
    const candidateTxGuids = [...new Set(taggedSplitsInAccount.map(s => s.tx_guid))];

    for (const txGuid of candidateTxGuids) {
      const txSplits = await tx.splits.findMany({
        where: { tx_guid: txGuid },
        select: { guid: true },
      });
      const txSplitGuids = txSplits.map(s => s.guid);

      // Check if ALL splits in this transaction are tagged
      const taggedCount = await tx.slots.count({
        where: {
          obj_guid: { in: txSplitGuids },
          name: 'gnucash_web_generated',
        },
      });

      if (taggedCount === txSplitGuids.length) {
        // All splits tagged — this is a generated gains transaction. Delete it.
        // Delete slots for splits
        await tx.slots.deleteMany({
          where: { obj_guid: { in: txSplitGuids } },
        });
        // Delete splits
        await tx.splits.deleteMany({
          where: { tx_guid: txGuid },
        });
        // Delete transaction slots
        await tx.slots.deleteMany({
          where: { obj_guid: txGuid },
        });
        // Delete transaction
        await tx.transactions.deleteMany({
          where: { guid: txGuid },
        });
      }
    }

    // Delete remaining tagged sub-splits (not part of fully-generated transactions)
    // Re-fetch since some may have been deleted above
    const remainingTaggedSlots = await tx.slots.findMany({
      where: {
        name: 'gnucash_web_generated',
        obj_guid: {
          in: (await tx.splits.findMany({
            where: { account_guid: accountGuid },
            select: { guid: true },
          })).map(s => s.guid),
        },
      },
      select: { obj_guid: true },
    });
    const remainingTaggedSplitGuids = remainingTaggedSlots.map(s => s.obj_guid);

    if (remainingTaggedSplitGuids.length > 0) {
      await tx.slots.deleteMany({
        where: { obj_guid: { in: remainingTaggedSplitGuids } },
      });
      await tx.splits.deleteMany({
        where: { guid: { in: remainingTaggedSplitGuids } },
      });
    }

    // 2. Unassign all remaining splits from lots
    const updateResult = await tx.splits.updateMany({
      where: { account_guid: accountGuid, lot_guid: { not: null } },
      data: { lot_guid: null },
    });

    // 3. Delete empty lots and their slots
    const emptyLots = await tx.lots.findMany({
      where: { account_guid: accountGuid },
      include: { _count: { select: { splits: true } } },
    });

    const lotsToDelete = emptyLots.filter(l => l._count.splits === 0);

    if (lotsToDelete.length > 0) {
      const deleteGuids = lotsToDelete.map(l => l.guid);
      await tx.slots.deleteMany({
        where: {
          obj_guid: { in: deleteGuids },
          name: { in: ['title', 'source_lot_guid', 'acquisition_date', 'gnucash_web_generated'] },
        },
      });
      await tx.lots.deleteMany({
        where: { guid: { in: deleteGuids } },
      });
    }

    return {
      splitsUnassigned: updateResult.count,
      lotsDeleted: lotsToDelete.length,
    };
  });
}

export async function revertScrubRun(runId: string): Promise<{ reverted: number }> {
  return prisma.$transaction(async (tx) => {
    // Find all entities tagged with this runId
    const taggedSlots = await tx.slots.findMany({
      where: { name: 'gnucash_web_generated', string_val: runId },
      select: { obj_guid: true },
    });
    const taggedGuids = taggedSlots.map(s => s.obj_guid);
    if (taggedGuids.length === 0) return { reverted: 0 };

    // Delete tagged transactions (and their splits)
    const taggedTxs = await tx.transactions.findMany({
      where: { guid: { in: taggedGuids } },
      select: { guid: true },
    });
    if (taggedTxs.length > 0) {
      const txGuids = taggedTxs.map(t => t.guid);
      await tx.splits.deleteMany({ where: { tx_guid: { in: txGuids } } });
      await tx.slots.deleteMany({ where: { obj_guid: { in: txGuids } } });
      await tx.transactions.deleteMany({ where: { guid: { in: txGuids } } });
    }

    // Delete tagged sub-splits
    const taggedSplits = await tx.splits.findMany({
      where: { guid: { in: taggedGuids } },
      select: { guid: true },
    });
    if (taggedSplits.length > 0) {
      const splitGuids = taggedSplits.map(s => s.guid);
      await tx.slots.deleteMany({ where: { obj_guid: { in: splitGuids } } });
      await tx.splits.deleteMany({ where: { guid: { in: splitGuids } } });
    }

    // Restore original sell splits from stored slots
    const originalQtySlots = await tx.slots.findMany({
      where: { name: 'original_quantity_num' },
      select: { obj_guid: true, string_val: true },
    });
    for (const slot of originalQtySlots) {
      const denomSlot = await tx.slots.findFirst({ where: { obj_guid: slot.obj_guid, name: 'original_quantity_denom' } });
      const valNumSlot = await tx.slots.findFirst({ where: { obj_guid: slot.obj_guid, name: 'original_value_num' } });
      const valDenomSlot = await tx.slots.findFirst({ where: { obj_guid: slot.obj_guid, name: 'original_value_denom' } });

      if (slot.string_val && denomSlot?.string_val && valNumSlot?.string_val && valDenomSlot?.string_val) {
        await tx.splits.update({
          where: { guid: slot.obj_guid },
          data: {
            quantity_num: BigInt(slot.string_val),
            quantity_denom: BigInt(denomSlot.string_val),
            value_num: BigInt(valNumSlot.string_val),
            value_denom: BigInt(valDenomSlot.string_val),
            lot_guid: null,
          },
        });
      }

      // Clean up the original slots
      await tx.slots.deleteMany({
        where: {
          obj_guid: slot.obj_guid,
          name: { in: ['original_quantity_num', 'original_quantity_denom', 'original_value_num', 'original_value_denom', 'gnucash_web_generated'] },
        },
      });
    }

    // Delete tagged lots
    const taggedLots = await tx.lots.findMany({
      where: { guid: { in: taggedGuids } },
      select: { guid: true },
    });
    if (taggedLots.length > 0) {
      const deleteLotGuids = taggedLots.map(l => l.guid);
      await tx.splits.updateMany({ where: { lot_guid: { in: deleteLotGuids } }, data: { lot_guid: null } });
      await tx.slots.deleteMany({ where: { obj_guid: { in: deleteLotGuids } } });
      await tx.lots.deleteMany({ where: { guid: { in: deleteLotGuids } } });
    }

    // Reopen lots that were closed by this run
    await tx.lots.updateMany({
      where: { guid: { in: taggedGuids }, is_closed: 1 },
      data: { is_closed: 0 },
    });

    return { reverted: taggedGuids.length };
  });
}

export async function scrubAllAccounts(
  method: 'fifo' | 'lifo' | 'average',
  bookAccountGuids: string[]
): Promise<{ results: AutoAssignResult[]; order: string[] }> {
  // 1. Find all STOCK/MUTUAL accounts
  const investmentAccounts = await prisma.accounts.findMany({
    where: { guid: { in: bookAccountGuids }, account_type: { in: ['STOCK', 'MUTUAL'] } },
    select: { guid: true, name: true, commodity_guid: true },
  });

  // 2. Build transfer dependency graph
  const dependencies = new Map<string, Set<string>>();
  for (const acct of investmentAccounts) {
    dependencies.set(acct.guid, new Set());
  }

  for (const acct of investmentAccounts) {
    const transferIns = await prisma.splits.findMany({
      where: { account_guid: acct.guid, quantity_num: { gt: 0 } },
      include: {
        transaction: {
          include: {
            splits: {
              include: {
                account: { select: { guid: true, commodity_guid: true, account_type: true } },
              },
            },
          },
        },
      },
    });

    for (const split of transferIns) {
      const txSplits = split.transaction?.splits || [];
      const matchingSend = txSplits.find(s =>
        s.account_guid !== acct.guid &&
        s.account?.commodity_guid === acct.commodity_guid &&
        s.account?.account_type !== 'TRADING' &&
        s.quantity_num < 0n
      );
      if (matchingSend && dependencies.has(matchingSend.account_guid)) {
        dependencies.get(acct.guid)!.add(matchingSend.account_guid);
      }
    }
  }

  // 3. Topological sort (Kahn's algorithm)
  const inDegree = new Map<string, number>();
  for (const [guid, deps] of dependencies) {
    inDegree.set(guid, deps.size);
  }
  const queue: string[] = [];
  for (const [guid, degree] of inDegree) {
    if (degree === 0) queue.push(guid);
  }
  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    for (const [guid, deps] of dependencies) {
      if (deps.has(current)) {
        deps.delete(current);
        inDegree.set(guid, (inDegree.get(guid) || 1) - 1);
        if (inDegree.get(guid) === 0) queue.push(guid);
      }
    }
  }
  // Add any accounts not in order (circular deps) at the end
  for (const acct of investmentAccounts) {
    if (!order.includes(acct.guid)) order.push(acct.guid);
  }

  // 4. Scrub each account in order
  const results: AutoAssignResult[] = [];
  for (const accountGuid of order) {
    try {
      const result = await autoAssignLots(accountGuid, method);
      results.push(result);
    } catch (error) {
      console.error(`Error scrubbing account ${accountGuid}:`, error);
      results.push({
        lotsCreated: 0, splitsAssigned: 0, splitsCreated: 0,
        gainsTransactions: 0, totalRealizedGain: 0,
        method, runId: '', warnings: [`Error: ${error}`],
      });
    }
  }

  return { results, order };
}

export interface WashSaleResult {
  splitGuid: string;
  sellDate: string;
  sellAccountGuid: string;
  sellAccountName: string;
  ticker: string;
  shares: number;
  loss: number;
  washBuyDate: string;
  washBuyAccountGuid: string;
  washBuyAccountName: string;
  daysApart: number;
}

/**
 * Detect wash sales across all STOCK/MUTUAL accounts in the book.
 *
 * IRS wash sale rule: A loss is disallowed if you buy substantially identical
 * securities within 30 days before or after the sale.
 *
 * This checks CROSS-ACCOUNT: if you sell AAPL at a loss in one account
 * and buy AAPL in another account within the window, it's a wash sale.
 */
export async function detectWashSales(
  bookAccountGuids: string[]
): Promise<WashSaleResult[]> {
  const investmentAccounts = await prisma.accounts.findMany({
    where: {
      guid: { in: bookAccountGuids },
      account_type: { in: ['STOCK', 'MUTUAL'] },
    },
    select: {
      guid: true,
      name: true,
      commodity_guid: true,
      commodity: { select: { mnemonic: true } },
    },
  });

  if (investmentAccounts.length === 0) return [];

  const accountsByCommodity = new Map<string, typeof investmentAccounts>();
  for (const acct of investmentAccounts) {
    if (!acct.commodity_guid) continue;
    const existing = accountsByCommodity.get(acct.commodity_guid) || [];
    existing.push(acct);
    accountsByCommodity.set(acct.commodity_guid, existing);
  }

  const washSales: WashSaleResult[] = [];
  const WASH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

  for (const [commodityGuid, accounts] of accountsByCommodity) {
    const accountGuids = accounts.map(a => a.guid);
    const ticker = accounts[0].commodity?.mnemonic || 'Unknown';

    const allSplits = await prisma.splits.findMany({
      where: { account_guid: { in: accountGuids } },
      include: {
        transaction: { select: { post_date: true } },
      },
      orderBy: { transaction: { post_date: 'asc' } },
    });

    // Identify sells and buys
    const buys = allSplits.filter(s =>
      toDecimalNumber(s.quantity_num, s.quantity_denom) > 0
    );

    // For sells, determine if they were at a loss using lot data or heuristic
    const sells: Array<typeof allSplits[0] & { realizedLoss: number }> = [];

    // Batch-fetch all lots referenced by splits to avoid N+1 queries
    const lotGuids = [...new Set(allSplits.filter(s => s.lot_guid).map(s => s.lot_guid!))];
    const lotsWithSplits = lotGuids.length > 0
      ? await prisma.lots.findMany({
          where: { guid: { in: lotGuids } },
          include: { splits: true },
        })
      : [];
    const lotMap = new Map(lotsWithSplits.map(l => [l.guid, l]));

    for (const s of allSplits) {
      const qty = toDecimalNumber(s.quantity_num, s.quantity_denom);
      if (qty >= 0) continue; // Not a sell

      const val = toDecimalNumber(s.value_num, s.value_denom);

      // If sell is assigned to a lot, check lot-level realized gain
      if (s.lot_guid) {
        const lot = lotMap.get(s.lot_guid);
        if (lot) {
          const totalValue = lot.splits.reduce(
            (sum, ls) => sum + toDecimalNumber(ls.value_num, ls.value_denom), 0
          );
          const totalQty = lot.splits.reduce(
            (sum, ls) => sum + toDecimalNumber(ls.quantity_num, ls.quantity_denom), 0
          );
          // Closed lot with negative total value = realized loss
          if (Math.abs(totalQty) < 0.0001 && totalValue < 0) {
            sells.push({ ...s, realizedLoss: totalValue });
            continue;
          }
        }
      }

      // Fallback: compare sell proceeds per share against average buy cost per share
      const accountBuys = buys.filter(b => b.account_guid === s.account_guid);
      if (accountBuys.length > 0) {
        const totalBuyQty = accountBuys.reduce(
          (sum, b) => sum + toDecimalNumber(b.quantity_num, b.quantity_denom), 0
        );
        const totalBuyCost = accountBuys.reduce(
          (sum, b) => sum + Math.abs(toDecimalNumber(b.value_num, b.value_denom)), 0
        );
        const avgCostPerShare = totalBuyQty > 0 ? totalBuyCost / totalBuyQty : 0;
        const sellProceedsPerShare = Math.abs(val / qty);
        if (sellProceedsPerShare < avgCostPerShare) {
          const loss = (sellProceedsPerShare - avgCostPerShare) * Math.abs(qty);
          sells.push({ ...s, realizedLoss: loss });
        }
      }
    }

    // Check each loss-sell for wash sale: any buy of same commodity within 30 days
    for (const sell of sells) {
      const sellDate = sell.transaction?.post_date;
      if (!sellDate) continue;
      const sellMs = sellDate.getTime();

      for (const buy of buys) {
        const buyDate = buy.transaction?.post_date;
        if (!buyDate) continue;
        const buyMs = buyDate.getTime();
        const diff = Math.abs(buyMs - sellMs);

        if (diff <= WASH_WINDOW_MS && buy.guid !== sell.guid) {
          const sellAccount = accounts.find(a => a.guid === sell.account_guid);
          const buyAccount = accounts.find(a => a.guid === buy.account_guid);
          const daysApart = Math.round(diff / (24 * 60 * 60 * 1000));

          washSales.push({
            splitGuid: sell.guid,
            sellDate: sellDate.toISOString(),
            sellAccountGuid: sell.account_guid,
            sellAccountName: sellAccount?.name || '',
            ticker,
            shares: Math.abs(toDecimalNumber(sell.quantity_num, sell.quantity_denom)),
            loss: sell.realizedLoss,
            washBuyDate: buyDate.toISOString(),
            washBuyAccountGuid: buy.account_guid,
            washBuyAccountName: buyAccount?.name || '',
            daysApart,
          });
          break; // One wash match per sell is enough
        }
      }
    }
  }

  return washSales;
}
