// src/app/api/membership/types/route.ts
//
// Membership type (dues level) list + create.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import {
  listMembershipTypes,
  createMembershipType,
  membershipTypeInputSchema,
  parseInput,
  MembershipValidationError,
} from '@/lib/services/membership.service';

/** GET /api/membership/types — all types with member counts. */
export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const bookGuid = await getActiveBookGuid();
    return NextResponse.json(await listMembershipTypes(bookGuid));
  } catch (error) {
    console.error('Error listing membership types:', error);
    return NextResponse.json({ error: 'Failed to list membership types' }, { status: 500 });
  }
}

/**
 * POST /api/membership/types
 * Body: { name, amount?, renewalMode?, graceDays?, active?, sortOrder? }.
 */
export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const bookGuid = await getActiveBookGuid();
    const body = await request.json().catch(() => null);
    const input = parseInput(membershipTypeInputSchema, body);
    const type = await createMembershipType(bookGuid, input);
    return NextResponse.json(type, { status: 201 });
  } catch (error) {
    if (error instanceof MembershipValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error creating membership type:', error);
    return NextResponse.json({ error: 'Failed to create membership type' }, { status: 500 });
  }
}
