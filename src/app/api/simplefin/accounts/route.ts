import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { decryptAccessUrl, fetchAccounts, SimpleFinAccessRevokedError } from '@/lib/services/simplefin.service';

// GET /api/simplefin/accounts -- list SimpleFin accounts with mapping status
export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { user, bookGuid } = roleResult;

    // Get connection for this book
    const connections = await prisma.$queryRaw<{
      id: number;
      access_url_encrypted: string;
    }[]>`
      SELECT id, access_url_encrypted FROM gnucash_web_simplefin_connections
      WHERE user_id = ${user.id} AND book_guid = ${bookGuid}
    `;

    if (connections.length === 0) {
      return NextResponse.json({ error: 'No SimpleFin connection found' }, { status: 404 });
    }

    const connection = connections[0];
    const accessUrl = decryptAccessUrl(connection.access_url_encrypted);

    // Fetch accounts from SimpleFin (no date range = just accounts, no transactions)
    const accountSet = await fetchAccounts(accessUrl);

    // Get existing mappings
    const mappings = await prisma.$queryRaw<{
      simplefin_account_id: string;
      gnucash_account_guid: string | null;
      last_sync_at: Date | null;
      is_investment: boolean;
    }[]>`
      SELECT simplefin_account_id, gnucash_account_guid, last_sync_at, is_investment
      FROM gnucash_web_simplefin_account_map
      WHERE connection_id = ${connection.id}
    `;
    const mappingMap = new Map(mappings.map(m => [m.simplefin_account_id, m]));

    // Build response with mapping status
    const accounts = accountSet.accounts.map(acc => {
      const mapping = mappingMap.get(acc.id);
      return {
        id: acc.id,
        name: acc.name,
        institution: acc.org?.name || null,
        currency: acc.currency,
        balance: acc.balance,
        availableBalance: acc['available-balance'] || null,
        gnucashAccountGuid: mapping?.gnucash_account_guid || null,
        lastSyncAt: mapping?.last_sync_at || null,
        isMapped: !!mapping?.gnucash_account_guid,
        hasHoldings: Array.isArray(acc.holdings) && acc.holdings.length > 0,
        isInvestment: mapping?.is_investment ?? false,
      };
    });

    return NextResponse.json({ accounts });
  } catch (error) {
    if (error instanceof SimpleFinAccessRevokedError) {
      return NextResponse.json({ error: error.message, revoked: true }, { status: 403 });
    }
    console.error('Error fetching SimpleFin accounts:', error);
    return NextResponse.json({ error: 'Failed to fetch accounts' }, { status: 500 });
  }
}
