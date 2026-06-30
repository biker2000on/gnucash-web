import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { getPreference } from '@/lib/user-preferences';

// GET /api/simplefin/status -- connection status + last sync
export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { user, bookGuid } = roleResult;

    const connections = await prisma.$queryRaw<{
      id: number;
      last_sync_at: Date | null;
      last_sync_status: string | null;
      last_sync_error: string | null;
      last_sync_error_at: Date | null;
      last_successful_sync_at: Date | null;
      sync_enabled: boolean;
      created_at: Date;
    }[]>`
      SELECT
        id,
        last_sync_at,
        last_sync_status,
        last_sync_error,
        last_sync_error_at,
        last_successful_sync_at,
        sync_enabled,
        created_at
      FROM gnucash_web_simplefin_connections
      WHERE user_id = ${user.id} AND book_guid = ${bookGuid}
    `;

    if (connections.length === 0) {
      return NextResponse.json({ connected: false });
    }

    const connection = connections[0];

    // Count mapped accounts
    const mappedCounts = await prisma.$queryRaw<{ total: bigint; mapped: bigint }[]>`
      SELECT
        COUNT(*) as total,
        COUNT(gnucash_account_guid) as mapped
      FROM gnucash_web_simplefin_account_map
      WHERE connection_id = ${connection.id}
    `;

    const accounts = await prisma.$queryRaw<{
      simplefin_account_id: string;
      simplefin_account_name: string | null;
      simplefin_institution: string | null;
      simplefin_last4: string | null;
      gnucash_account_guid: string | null;
      last_sync_at: Date | null;
      is_investment: boolean;
      last_balance: number | null;
      last_balance_date: Date | null;
    }[]>`
      SELECT
        simplefin_account_id,
        simplefin_account_name,
        simplefin_institution,
        simplefin_last4,
        gnucash_account_guid,
        last_sync_at,
        is_investment,
        last_balance,
        last_balance_date
      FROM gnucash_web_simplefin_account_map
      WHERE connection_id = ${connection.id}
      ORDER BY simplefin_institution NULLS LAST, simplefin_account_name NULLS LAST, simplefin_account_id
    `;

    // Check if SimpleFin sync with refresh is enabled (user preference)
    const syncWithRefresh = await getPreference<string>(user.id, 'simplefin_sync_with_refresh', 'false');

    return NextResponse.json({
      connected: true,
      connectionId: connection.id,
      lastSyncAt: connection.last_sync_at,
      lastSuccessfulSyncAt: connection.last_successful_sync_at,
      syncStatus: connection.last_sync_status,
      lastSyncError: connection.last_sync_error,
      lastSyncErrorAt: connection.last_sync_error_at,
      revoked: connection.last_sync_status === 'revoked',
      syncEnabled: syncWithRefresh === 'true',
      connectedAt: connection.created_at,
      accountsTotal: Number(mappedCounts[0]?.total || 0),
      accountsMapped: Number(mappedCounts[0]?.mapped || 0),
      accounts: accounts.map(account => ({
        id: account.simplefin_account_id,
        name: account.simplefin_account_name || account.simplefin_account_id,
        institution: account.simplefin_institution,
        last4: account.simplefin_last4,
        currency: null,
        balance: account.last_balance === null ? null : String(account.last_balance),
        availableBalance: null,
        lastBalanceDate: account.last_balance_date,
        gnucashAccountGuid: account.gnucash_account_guid,
        lastSyncAt: account.last_sync_at,
        isMapped: !!account.gnucash_account_guid,
        hasHoldings: false,
        isInvestment: account.is_investment,
        isLive: false,
        isStored: true,
        liveMissing: true,
      })),
    });
  } catch (error) {
    console.error('Error fetching SimpleFin status:', error);
    return NextResponse.json({ error: 'Failed to fetch status' }, { status: 500 });
  }
}
