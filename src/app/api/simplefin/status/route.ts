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
      sync_enabled: boolean;
      created_at: Date;
    }[]>`
      SELECT id, last_sync_at, sync_enabled, created_at
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

    // Check if SimpleFin sync with refresh is enabled (user preference)
    const syncWithRefresh = await getPreference<string>(user.id, 'simplefin_sync_with_refresh', 'false');

    return NextResponse.json({
      connected: true,
      connectionId: connection.id,
      lastSyncAt: connection.last_sync_at,
      syncEnabled: syncWithRefresh === 'true',
      connectedAt: connection.created_at,
      accountsTotal: Number(mappedCounts[0]?.total || 0),
      accountsMapped: Number(mappedCounts[0]?.mapped || 0),
    });
  } catch (error) {
    console.error('Error fetching SimpleFin status:', error);
    return NextResponse.json({ error: 'Failed to fetch status' }, { status: 500 });
  }
}
