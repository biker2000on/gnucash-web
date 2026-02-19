import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { claimSetupToken, encryptAccessUrl, SimpleFinError } from '@/lib/services/simplefin.service';

// POST /api/simplefin/connect -- claim setup token and store connection
export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;

    const { user, bookGuid } = roleResult;
    const { setupToken } = await request.json();

    if (!setupToken || typeof setupToken !== 'string') {
      return NextResponse.json({ error: 'Setup token is required' }, { status: 400 });
    }

    // Check if connection already exists for this user + book
    const existing = await prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM gnucash_web_simplefin_connections
      WHERE user_id = ${user.id} AND book_guid = ${bookGuid}
    `;

    if (existing.length > 0) {
      return NextResponse.json(
        { error: 'A SimpleFin connection already exists for this book. Disconnect first.' },
        { status: 409 }
      );
    }

    // Claim the setup token to get the access URL
    const accessUrl = await claimSetupToken(setupToken);

    // Encrypt and store
    const encryptedUrl = encryptAccessUrl(accessUrl);

    await prisma.$executeRaw`
      INSERT INTO gnucash_web_simplefin_connections (user_id, book_guid, access_url_encrypted)
      VALUES (${user.id}, ${bookGuid}, ${encryptedUrl})
    `;

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof SimpleFinError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('Error connecting SimpleFin:', error);
    return NextResponse.json({ error: 'Failed to connect SimpleFin' }, { status: 500 });
  }
}
