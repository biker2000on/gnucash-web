// src/app/api/membership/types/[id]/route.ts
//
// Membership type update/delete. DELETE is blocked (400) while members or
// payments still reference the type — deactivate instead.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import {
  updateMembershipType,
  deleteMembershipType,
  membershipTypeInputSchema,
  parseInput,
  MembershipValidationError,
} from '@/lib/services/membership.service';

function parseId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** PUT /api/membership/types/{id} — full update (same body as POST). */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id } = await params;
    const typeId = parseId(id);
    if (typeId === null) {
      return NextResponse.json({ error: 'Membership type not found' }, { status: 404 });
    }

    const bookGuid = await getActiveBookGuid();
    const body = await request.json().catch(() => null);
    const input = parseInput(membershipTypeInputSchema, body);
    const type = await updateMembershipType(bookGuid, typeId, input);
    if (!type) {
      return NextResponse.json({ error: 'Membership type not found' }, { status: 404 });
    }
    return NextResponse.json(type);
  } catch (error) {
    if (error instanceof MembershipValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error updating membership type:', error);
    return NextResponse.json({ error: 'Failed to update membership type' }, { status: 500 });
  }
}

/** DELETE /api/membership/types/{id} — 400 when still referenced. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id } = await params;
    const typeId = parseId(id);
    if (typeId === null) {
      return NextResponse.json({ error: 'Membership type not found' }, { status: 404 });
    }

    const bookGuid = await getActiveBookGuid();
    const result = await deleteMembershipType(bookGuid, typeId);
    if (!result) {
      return NextResponse.json({ error: 'Membership type not found' }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof MembershipValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error deleting membership type:', error);
    return NextResponse.json({ error: 'Failed to delete membership type' }, { status: 500 });
  }
}
