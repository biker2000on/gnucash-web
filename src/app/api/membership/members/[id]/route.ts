// src/app/api/membership/members/[id]/route.ts
//
// Single-member read/update/delete. DELETE cascades payments + attendance
// (the UI confirms before calling).

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import {
  getMember,
  updateMember,
  deleteMember,
  memberInputSchema,
  parseInput,
  MembershipValidationError,
} from '@/lib/services/membership.service';

function parseId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** GET /api/membership/members/{id} — member + payments + attendance history. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id } = await params;
    const memberId = parseId(id);
    if (memberId === null) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    const bookGuid = await getActiveBookGuid();
    const member = await getMember(bookGuid, memberId);
    if (!member) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }
    return NextResponse.json(member);
  } catch (error) {
    console.error('Error fetching member:', error);
    return NextResponse.json({ error: 'Failed to fetch member' }, { status: 500 });
  }
}

/** PUT /api/membership/members/{id} — full update (same body as POST). */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id } = await params;
    const memberId = parseId(id);
    if (memberId === null) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    const bookGuid = await getActiveBookGuid();
    const body = await request.json().catch(() => null);
    const input = parseInput(memberInputSchema, body);
    const member = await updateMember(bookGuid, memberId, input);
    if (!member) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }
    return NextResponse.json(member);
  } catch (error) {
    if (error instanceof MembershipValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error updating member:', error);
    return NextResponse.json({ error: 'Failed to update member' }, { status: 500 });
  }
}

/** DELETE /api/membership/members/{id} — hard delete; cascades payments/attendance. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id } = await params;
    const memberId = parseId(id);
    if (memberId === null) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    const bookGuid = await getActiveBookGuid();
    const result = await deleteMember(bookGuid, memberId);
    if (!result) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error deleting member:', error);
    return NextResponse.json({ error: 'Failed to delete member' }, { status: 500 });
  }
}
