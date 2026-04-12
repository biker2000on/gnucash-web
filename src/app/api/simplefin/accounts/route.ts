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
    const connection = await prisma.gnucash_web_simplefin_connections.findFirst({
      where: { user_id: user.id, book_guid: bookGuid },
      select: { id: true, access_url_encrypted: true },
    });

    if (!connection) {
      return NextResponse.json({ error: 'No SimpleFin connection found' }, { status: 404 });
    }
    const accessUrl = decryptAccessUrl(connection.access_url_encrypted);

    // Fetch accounts from SimpleFin (no date range = just accounts, no transactions)
    const accountSet = await fetchAccounts(accessUrl);

    // Get existing mappings
    const mappings = await prisma.gnucash_web_simplefin_account_map.findMany({
      where: { connection_id: connection.id },
      select: { simplefin_account_id: true, gnucash_account_guid: true, last_sync_at: true, is_investment: true },
    });
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
