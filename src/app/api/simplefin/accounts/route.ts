import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { decryptAccessUrl, fetchAccounts, SimpleFinAccessRevokedError } from '@/lib/services/simplefin.service';
import { isNonFatalSimpleFinWarning, updateSimpleFinConnectionSyncStatus } from '@/lib/services/simplefin-sync.service';

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
    const mappings = await prisma.gnucash_web_simplefin_account_map.findMany({
      where: { connection_id: connection.id },
      select: {
        simplefin_account_id: true,
        simplefin_account_name: true,
        simplefin_institution: true,
        simplefin_last4: true,
        gnucash_account_guid: true,
        last_sync_at: true,
        is_investment: true,
        last_balance: true,
        last_balance_date: true,
      },
      orderBy: [
        { simplefin_institution: 'asc' },
        { simplefin_account_name: 'asc' },
        { simplefin_account_id: 'asc' },
      ],
    });

    const accountMap = new Map(mappings.map(mapping => [
      mapping.simplefin_account_id,
      {
        id: mapping.simplefin_account_id,
        name: mapping.simplefin_account_name || mapping.simplefin_account_id,
        institution: mapping.simplefin_institution,
        last4: mapping.simplefin_last4,
        currency: null as string | null,
        balance: mapping.last_balance === null ? null : String(mapping.last_balance),
        availableBalance: null as string | null,
        lastBalanceDate: mapping.last_balance_date,
        gnucashAccountGuid: mapping.gnucash_account_guid,
        lastSyncAt: mapping.last_sync_at,
        isMapped: !!mapping.gnucash_account_guid,
        hasHoldings: false,
        isInvestment: mapping.is_investment,
        isLive: false,
        isStored: true,
        liveMissing: true,
      },
    ]));

    try {
      const accessUrl = decryptAccessUrl(connection.access_url_encrypted);
      // Fetch accounts from SimpleFin (no date range = just accounts, no transactions)
      const accountSet = await fetchAccounts(accessUrl);
      const simplefinWarnings = accountSet.errors.filter(isNonFatalSimpleFinWarning);
      const simplefinErrors = accountSet.errors.filter(error => !isNonFatalSimpleFinWarning(error));
      const liveError = simplefinErrors.length > 0 ? simplefinErrors.join('\n') : null;
      const now = new Date();

      for (const acc of accountSet.accounts) {
        const stored = accountMap.get(acc.id);
        const parsedBalance = acc.balance === undefined ? null : Number.parseFloat(acc.balance);
        const liveBalance = parsedBalance === null || Number.isNaN(parsedBalance) ? null : parsedBalance;
        const liveBalanceDate = liveBalance === null ? null : now;

        await prisma.$executeRaw`
          INSERT INTO gnucash_web_simplefin_account_map
            (
              connection_id,
              simplefin_account_id,
              simplefin_account_name,
              simplefin_institution,
              simplefin_last4,
              gnucash_account_guid,
              is_investment,
              last_balance,
              last_balance_date,
              last_sync_at
            )
          VALUES
            (
              ${connection.id},
              ${acc.id},
              ${acc.name || null},
              ${acc.org?.name || null},
              ${stored?.last4 || null},
              ${stored?.gnucashAccountGuid || null},
              ${stored?.isInvestment ?? false},
              ${liveBalance},
              ${liveBalanceDate},
              ${now}
            )
          ON CONFLICT (connection_id, simplefin_account_id)
          DO UPDATE SET
            simplefin_account_name = COALESCE(${acc.name || null}, gnucash_web_simplefin_account_map.simplefin_account_name),
            simplefin_institution = COALESCE(${acc.org?.name || null}, gnucash_web_simplefin_account_map.simplefin_institution),
            last_balance = COALESCE(${liveBalance}, gnucash_web_simplefin_account_map.last_balance),
            last_balance_date = COALESCE(${liveBalanceDate}, gnucash_web_simplefin_account_map.last_balance_date),
            last_sync_at = ${now}
        `;

        accountMap.set(acc.id, {
          id: acc.id,
          name: acc.name,
          institution: acc.org?.name || stored?.institution || null,
          last4: stored?.last4 || null,
          currency: acc.currency,
          balance: acc.balance,
          availableBalance: acc['available-balance'] || null,
          lastBalanceDate: stored?.lastBalanceDate || null,
          gnucashAccountGuid: stored?.gnucashAccountGuid || null,
          lastSyncAt: stored?.lastSyncAt || null,
          isMapped: !!stored?.gnucashAccountGuid,
          hasHoldings: Array.isArray(acc.holdings) && acc.holdings.length > 0,
          isInvestment: stored?.isInvestment ?? false,
          isLive: true,
          isStored: !!stored,
          liveMissing: false,
        });
      }

      return NextResponse.json({
        accounts: Array.from(accountMap.values()),
        live: true,
        liveError,
        simplefinErrors,
        simplefinWarnings,
      });
    } catch (error) {
      const isRevoked = error instanceof SimpleFinAccessRevokedError;
      const message = isRevoked
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Failed to fetch accounts from SimpleFin';

      await updateSimpleFinConnectionSyncStatus(
        connection.id,
        isRevoked ? 'revoked' : 'failed',
        message,
      );

      return NextResponse.json({
        accounts: Array.from(accountMap.values()),
        live: false,
        liveError: message,
        revoked: isRevoked,
      });
    }
  } catch (error) {
    console.error('Error fetching SimpleFin accounts:', error);
    return NextResponse.json({ error: 'Failed to fetch accounts' }, { status: 500 });
  }
}
