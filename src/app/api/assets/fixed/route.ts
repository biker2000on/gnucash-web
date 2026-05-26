/**
 * Fixed Assets API
 *
 * GET /api/assets/fixed - Returns explicitly selected fixed asset accounts.
 * Selection is provided by accountGuids or by parentGuid. No accounts are returned
 * without a selection because not every ASSET account is a fixed asset.
 * Includes current balance, depreciation schedule if configured, and last transaction date.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

interface FixedAssetAccount {
  guid: string;
  name: string;
  accountPath: string;
  currentBalance: number;
  lastTransactionDate: string | null;
  depreciationSchedule: {
    id: number;
    method: string;
    frequency: string;
    isAppreciation: boolean;
    enabled: boolean;
    purchasePrice: number;
    salvageValue: number;
    usefulLifeYears: number;
  } | null;
}

export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const bookAccountGuids = await getBookAccountGuids();
    const searchParams = request.nextUrl.searchParams;
    const parentGuid = searchParams.get('parentGuid');
    const accountGuids = searchParams.get('accountGuids')
      ?.split(',')
      .map((guid) => guid.trim())
      .filter(Boolean) ?? [];

    if (!parentGuid && accountGuids.length === 0) {
      return NextResponse.json({ assets: [] });
    }

    let selectedGuids = accountGuids.filter((guid) => bookAccountGuids.includes(guid));

    if (parentGuid && bookAccountGuids.includes(parentGuid)) {
      const descendants = await prisma.$queryRaw<Array<{ guid: string }>>`
        WITH RECURSIVE descendants AS (
          SELECT guid, parent_guid
          FROM accounts
          WHERE guid = ${parentGuid}

          UNION ALL

          SELECT a.guid, a.parent_guid
          FROM accounts a
          JOIN descendants d ON a.parent_guid = d.guid
        )
        SELECT guid FROM descendants
      `;
      selectedGuids = descendants
        .map((row) => row.guid)
        .filter((guid) => bookAccountGuids.includes(guid));
    }

    const assetAccounts = await prisma.accounts.findMany({
      where: {
        guid: { in: selectedGuids },
        account_type: 'ASSET',
        placeholder: { not: 1 },
      },
      select: {
        guid: true,
        name: true,
      },
    });

    const fixedAssetGuids = assetAccounts.map((a) => a.guid);

    if (fixedAssetGuids.length === 0) {
      return NextResponse.json({ assets: [] });
    }

    // Build account paths using the hierarchy view
    const pathResults = await prisma.$queryRaw<
      Array<{ guid: string; fullname: string }>
    >`
      SELECT guid, fullname
      FROM account_hierarchy
      WHERE guid = ANY(${fixedAssetGuids})
    `;
    const pathMap = new Map(pathResults.map((r) => [r.guid, r.fullname]));

    // Get balances for all fixed asset accounts
    const balanceResults = await prisma.$queryRaw<
      Array<{ account_guid: string; balance: string }>
    >`
      SELECT
        account_guid,
        COALESCE(SUM(CAST(value_num AS DOUBLE PRECISION) / CAST(value_denom AS DOUBLE PRECISION)), 0)::TEXT AS balance
      FROM splits
      WHERE account_guid = ANY(${fixedAssetGuids})
      GROUP BY account_guid
    `;
    const balanceMap = new Map(
      balanceResults.map((r) => [r.account_guid, parseFloat(r.balance)])
    );

    // Get last transaction dates
    const lastTxResults = await prisma.$queryRaw<
      Array<{ account_guid: string; last_date: Date | null }>
    >`
      SELECT
        s.account_guid,
        MAX(t.post_date) AS last_date
      FROM splits s
      JOIN transactions t ON t.guid = s.tx_guid
      WHERE s.account_guid = ANY(${fixedAssetGuids})
      GROUP BY s.account_guid
    `;
    const lastTxMap = new Map(
      lastTxResults.map((r) => [
        r.account_guid,
        r.last_date ? r.last_date.toISOString().split('T')[0] : null,
      ])
    );

    // Get depreciation schedules for these accounts
    const schedules = await prisma.gnucash_web_depreciation_schedules.findMany({
      where: {
        account_guid: { in: fixedAssetGuids },
      },
    });
    const scheduleMap = new Map(
      schedules.map((s) => [s.account_guid, s])
    );

    // Build response
    const assets: FixedAssetAccount[] = assetAccounts
      .filter((a) => fixedAssetGuids.includes(a.guid))
      .map((a) => {
        const schedule = scheduleMap.get(a.guid);
        return {
          guid: a.guid,
          name: a.name,
          accountPath: pathMap.get(a.guid) || a.name,
          currentBalance: balanceMap.get(a.guid) || 0,
          lastTransactionDate: lastTxMap.get(a.guid) || null,
          depreciationSchedule: schedule
            ? {
                id: schedule.id,
                method: schedule.method,
                frequency: schedule.frequency,
                isAppreciation: schedule.is_appreciation,
                enabled: schedule.enabled,
                purchasePrice: Number(schedule.purchase_price),
                salvageValue: Number(schedule.salvage_value),
                usefulLifeYears: schedule.useful_life_years,
              }
            : null,
        };
      })
      .sort((a, b) => a.accountPath.localeCompare(b.accountPath));

    return NextResponse.json({ assets });
  } catch (err) {
    console.error('Error fetching fixed assets:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
