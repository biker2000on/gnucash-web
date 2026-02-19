import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import prisma from '@/lib/prisma';

// PUT /api/simplefin/accounts/map -- update account mapping
export async function PUT(request: NextRequest) {
  try {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;

    const { user, bookGuid } = roleResult;
    const { mappings } = await request.json();

    if (!Array.isArray(mappings)) {
      return NextResponse.json({ error: 'mappings must be an array' }, { status: 400 });
    }

    // Get connection
    const connections = await prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM gnucash_web_simplefin_connections
      WHERE user_id = ${user.id} AND book_guid = ${bookGuid}
    `;

    if (connections.length === 0) {
      return NextResponse.json({ error: 'No SimpleFin connection found' }, { status: 404 });
    }

    const connectionId = connections[0].id;

    // Upsert each mapping
    for (const mapping of mappings) {
      const { simpleFinAccountId, simpleFinAccountName, simpleFinInstitution, simpleFinLast4, gnucashAccountGuid } = mapping;

      if (!simpleFinAccountId) continue;

      await prisma.$executeRaw`
        INSERT INTO gnucash_web_simplefin_account_map
          (connection_id, simplefin_account_id, simplefin_account_name, simplefin_institution, simplefin_last4, gnucash_account_guid)
        VALUES
          (${connectionId}, ${simpleFinAccountId}, ${simpleFinAccountName || null}, ${simpleFinInstitution || null}, ${simpleFinLast4 || null}, ${gnucashAccountGuid || null})
        ON CONFLICT (connection_id, simplefin_account_id)
        DO UPDATE SET
          gnucash_account_guid = ${gnucashAccountGuid || null},
          simplefin_account_name = COALESCE(${simpleFinAccountName || null}, gnucash_web_simplefin_account_map.simplefin_account_name),
          simplefin_institution = COALESCE(${simpleFinInstitution || null}, gnucash_web_simplefin_account_map.simplefin_institution),
          simplefin_last4 = COALESCE(${simpleFinLast4 || null}, gnucash_web_simplefin_account_map.simplefin_last4)
      `;
    }

    return NextResponse.json({ success: true, mapped: mappings.length });
  } catch (error) {
    console.error('Error updating account mappings:', error);
    return NextResponse.json({ error: 'Failed to update mappings' }, { status: 500 });
  }
}
