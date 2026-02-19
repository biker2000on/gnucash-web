import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import prisma from '@/lib/prisma';

// DELETE /api/simplefin/disconnect -- remove SimpleFin connection
export async function DELETE() {
  try {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;

    const { user, bookGuid } = roleResult;

    // Delete connection (cascade will remove account mappings)
    const result = await prisma.$executeRaw`
      DELETE FROM gnucash_web_simplefin_connections
      WHERE user_id = ${user.id} AND book_guid = ${bookGuid}
    `;

    if (result === 0) {
      return NextResponse.json({ error: 'No SimpleFin connection found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error disconnecting SimpleFin:', error);
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
}
