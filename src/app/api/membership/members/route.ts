// src/app/api/membership/members/route.ts
//
// Member list + create. All rows are scoped to the active book.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import {
  listMembers,
  createMember,
  memberInputSchema,
  parseInput,
  MembershipValidationError,
} from '@/lib/services/membership.service';

/** GET /api/membership/members — all members with derived dues status. */
export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const bookGuid = await getActiveBookGuid();
    return NextResponse.json(await listMembers(bookGuid));
  } catch (error) {
    console.error('Error listing members:', error);
    return NextResponse.json({ error: 'Failed to list members' }, { status: 500 });
  }
}

/**
 * POST /api/membership/members
 * Body: { name, email?, phone?, address?, membershipTypeId?, joinedDate?,
 *         status?, notes? }.
 */
export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const bookGuid = await getActiveBookGuid();
    const body = await request.json().catch(() => null);
    const input = parseInput(memberInputSchema, body);
    const member = await createMember(bookGuid, input);
    return NextResponse.json(member, { status: 201 });
  } catch (error) {
    if (error instanceof MembershipValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error creating member:', error);
    return NextResponse.json({ error: 'Failed to create member' }, { status: 500 });
  }
}
