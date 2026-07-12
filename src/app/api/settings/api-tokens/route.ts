import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { createToken, listTokens, type TokenRole } from '@/lib/api-tokens';

function serializeToken(t: {
  id: number;
  name: string;
  prefix: string;
  role: TokenRole;
  bookGuid: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    role: t.role,
    bookGuid: t.bookGuid,
    expiresAt: t.expiresAt?.toISOString() ?? null,
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}

/** GET /api/settings/api-tokens — list the current user's tokens. */
export async function GET() {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    if (roleResult.viaToken) {
      return NextResponse.json({ error: 'API tokens cannot manage API tokens' }, { status: 403 });
    }

    const tokens = await listTokens(roleResult.user.id);
    return NextResponse.json({ tokens: tokens.map(serializeToken) });
  } catch (error) {
    console.error('Error listing API tokens:', error);
    return NextResponse.json({ error: 'Failed to list API tokens' }, { status: 500 });
  }
}

/**
 * POST /api/settings/api-tokens — create a token.
 * Body: { name, role: 'readonly'|'edit', scopeToBook?: boolean, expiresAt?: ISO string }
 * Returns the plaintext secret exactly once.
 */
export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    if (roleResult.viaToken) {
      return NextResponse.json({ error: 'API tokens cannot manage API tokens' }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body.name !== 'string' || !body.name.trim()) {
      return NextResponse.json({ error: 'Token name is required' }, { status: 400 });
    }

    const role: TokenRole = body.role === 'edit' ? 'edit' : 'readonly';

    // A token can never grant more than the creating user has on this book.
    const ROLE_HIERARCHY: Record<string, number> = { readonly: 0, edit: 1, admin: 2 };
    if (ROLE_HIERARCHY[role] > ROLE_HIERARCHY[roleResult.role]) {
      return NextResponse.json(
        { error: `You cannot create a ${role} token with only ${roleResult.role} access` },
        { status: 403 }
      );
    }

    let expiresAt: Date | null = null;
    if (body.expiresAt) {
      expiresAt = new Date(body.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) {
        return NextResponse.json({ error: 'Invalid expiresAt date' }, { status: 400 });
      }
      if (expiresAt.getTime() <= Date.now()) {
        return NextResponse.json({ error: 'expiresAt must be in the future' }, { status: 400 });
      }
    }

    const { token, secret } = await createToken(roleResult.user.id, {
      name: body.name,
      role,
      bookGuid: body.scopeToBook === false ? null : roleResult.bookGuid,
      expiresAt,
    });

    return NextResponse.json({ token: serializeToken(token), secret }, { status: 201 });
  } catch (error) {
    console.error('Error creating API token:', error);
    return NextResponse.json({ error: 'Failed to create API token' }, { status: 500 });
  }
}
