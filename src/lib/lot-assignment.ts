/**
 * Lot Assignment Service
 *
 * Implements auto-assign algorithms (FIFO, LIFO, average) and
 * bulk operations (clear-assign) for lot management.
 */

import prisma from './prisma';
import { generateGuid, toDecimal as toDecimalString } from './gnucash';

function toDecimal(num: bigint, denom: bigint): number {
  return parseFloat(toDecimalString(num, denom));
}

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
  method: string;
}

async function getUnassignedSplits(
  accountGuid: string,
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
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
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
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
  return guid;
}

async function assignFIFO(
  accountGuid: string,
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
): Promise<AutoAssignResult> {
  const splits = await getUnassignedSplits(accountGuid, tx);
  if (splits.length === 0) return { lotsCreated: 0, splitsAssigned: 0, method: 'fifo' };

  const buys = splits.filter(s => toDecimal(s.quantity_num, s.quantity_denom) > 0);
  const sells = splits.filter(s => toDecimal(s.quantity_num, s.quantity_denom) < 0);

  buys.sort((a, b) => (a.post_date?.getTime() || 0) - (b.post_date?.getTime() || 0));

  let lotsCreated = 0;

  const existingLots = await tx.lots.findMany({
    where: { account_guid: accountGuid, is_closed: 0 },
    include: { splits: { select: { quantity_num: true, quantity_denom: true } } },
  });

  const lotShareMap = new Map<string, number>();
  const lotOrder: string[] = [];

  for (const lot of existingLots) {
    const shares = lot.splits.reduce(
      (sum, s) => sum + toDecimal(s.quantity_num, s.quantity_denom), 0
    );
    if (Math.abs(shares) > 0.0001) {
      lotShareMap.set(lot.guid, shares);
      lotOrder.push(lot.guid);
    }
  }

  for (const buy of buys) {
    const dateStr = buy.post_date
      ? buy.post_date.toISOString().split('T')[0]
      : 'Unknown';
    const title = `Buy ${dateStr}`;
    const lotGuid = await createLot(accountGuid, title, tx);
    lotsCreated++;

    await tx.splits.update({
      where: { guid: buy.guid },
      data: { lot_guid: lotGuid },
    });

    const qty = toDecimal(buy.quantity_num, buy.quantity_denom);
    lotShareMap.set(lotGuid, qty);
    lotOrder.push(lotGuid);
  }

  for (const sell of sells) {
    const targetLotGuid = lotOrder.find(g => (lotShareMap.get(g) || 0) > 0.0001);
    if (targetLotGuid) {
      await tx.splits.update({
        where: { guid: sell.guid },
        data: { lot_guid: targetLotGuid },
      });
      const sellQty = toDecimal(sell.quantity_num, sell.quantity_denom);
      lotShareMap.set(targetLotGuid, (lotShareMap.get(targetLotGuid) || 0) + sellQty);
    } else {
      const lastLot = lotOrder[lotOrder.length - 1];
      if (lastLot) {
        await tx.splits.update({
          where: { guid: sell.guid },
          data: { lot_guid: lastLot },
        });
      }
    }
  }

  return {
    lotsCreated,
    splitsAssigned: splits.length,
    method: 'fifo',
  };
}

async function assignLIFO(
  accountGuid: string,
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
): Promise<AutoAssignResult> {
  const splits = await getUnassignedSplits(accountGuid, tx);
  if (splits.length === 0) return { lotsCreated: 0, splitsAssigned: 0, method: 'lifo' };

  const buys = splits.filter(s => toDecimal(s.quantity_num, s.quantity_denom) > 0);
  const sells = splits.filter(s => toDecimal(s.quantity_num, s.quantity_denom) < 0);

  buys.sort((a, b) => (a.post_date?.getTime() || 0) - (b.post_date?.getTime() || 0));

  let lotsCreated = 0;

  const existingLots = await tx.lots.findMany({
    where: { account_guid: accountGuid, is_closed: 0 },
    include: { splits: { select: { quantity_num: true, quantity_denom: true } } },
  });

  const lotShareMap = new Map<string, number>();
  const lotOrder: string[] = [];

  for (const lot of existingLots) {
    const shares = lot.splits.reduce(
      (sum, s) => sum + toDecimal(s.quantity_num, s.quantity_denom), 0
    );
    if (Math.abs(shares) > 0.0001) {
      lotShareMap.set(lot.guid, shares);
      lotOrder.push(lot.guid);
    }
  }

  for (const buy of buys) {
    const dateStr = buy.post_date
      ? buy.post_date.toISOString().split('T')[0]
      : 'Unknown';
    const title = `Buy ${dateStr}`;
    const lotGuid = await createLot(accountGuid, title, tx);
    lotsCreated++;

    await tx.splits.update({
      where: { guid: buy.guid },
      data: { lot_guid: lotGuid },
    });

    const qty = toDecimal(buy.quantity_num, buy.quantity_denom);
    lotShareMap.set(lotGuid, qty);
    lotOrder.push(lotGuid);
  }

  // LIFO: assign sells to MOST RECENT lot with remaining shares (reverse order)
  for (const sell of sells) {
    const reversedOrder = [...lotOrder].reverse();
    const targetLotGuid = reversedOrder.find(g => (lotShareMap.get(g) || 0) > 0.0001);
    if (targetLotGuid) {
      await tx.splits.update({
        where: { guid: sell.guid },
        data: { lot_guid: targetLotGuid },
      });
      const sellQty = toDecimal(sell.quantity_num, sell.quantity_denom);
      lotShareMap.set(targetLotGuid, (lotShareMap.get(targetLotGuid) || 0) + sellQty);
    } else {
      const lastLot = lotOrder[lotOrder.length - 1];
      if (lastLot) {
        await tx.splits.update({
          where: { guid: sell.guid },
          data: { lot_guid: lastLot },
        });
      }
    }
  }

  return {
    lotsCreated,
    splitsAssigned: splits.length,
    method: 'lifo',
  };
}

async function assignAverage(
  accountGuid: string,
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
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
    const updateResult = await tx.splits.updateMany({
      where: { account_guid: accountGuid, lot_guid: { not: null } },
      data: { lot_guid: null },
    });

    const emptyLots = await tx.lots.findMany({
      where: { account_guid: accountGuid },
      include: { _count: { select: { splits: true } } },
    });

    const lotsToDelete = emptyLots.filter(l => l._count.splits === 0);

    if (lotsToDelete.length > 0) {
      const lotGuids = lotsToDelete.map(l => l.guid);
      await tx.slots.deleteMany({
        where: { obj_guid: { in: lotGuids }, name: 'title' },
      });
      await tx.lots.deleteMany({
        where: { guid: { in: lotGuids } },
      });
    }

    return {
      splitsUnassigned: updateResult.count,
      lotsDeleted: lotsToDelete.length,
    };
  });
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
      toDecimal(s.quantity_num, s.quantity_denom) > 0
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
      const qty = toDecimal(s.quantity_num, s.quantity_denom);
      if (qty >= 0) continue; // Not a sell

      const val = toDecimal(s.value_num, s.value_denom);

      // If sell is assigned to a lot, check lot-level realized gain
      if (s.lot_guid) {
        const lot = lotMap.get(s.lot_guid);
        if (lot) {
          const totalValue = lot.splits.reduce(
            (sum, ls) => sum + toDecimal(ls.value_num, ls.value_denom), 0
          );
          const totalQty = lot.splits.reduce(
            (sum, ls) => sum + toDecimal(ls.quantity_num, ls.quantity_denom), 0
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
          (sum, b) => sum + toDecimal(b.quantity_num, b.quantity_denom), 0
        );
        const totalBuyCost = accountBuys.reduce(
          (sum, b) => sum + Math.abs(toDecimal(b.value_num, b.value_denom)), 0
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
            shares: Math.abs(toDecimal(sell.quantity_num, sell.quantity_denom)),
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
