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
