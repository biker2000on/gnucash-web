// src/app/api/membership/meetings/[id]/route.ts
//
// Single-meeting read/update/delete. GET includes the full roll-call roster
// (active + honorary members plus anyone already recorded) with per-member
// attendance status.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import {
  getMeeting,
  updateMeeting,
  deleteMeeting,
  meetingInputSchema,
  parseInput,
  MembershipValidationError,
} from '@/lib/services/membership.service';

function parseId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** GET /api/membership/meetings/{id} — meeting + attendance roster. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id } = await params;
    const meetingId = parseId(id);
    if (meetingId === null) {
      return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
    }

    const bookGuid = await getActiveBookGuid();
    const meeting = await getMeeting(bookGuid, meetingId);
    if (!meeting) {
      return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
    }
    return NextResponse.json(meeting);
  } catch (error) {
    console.error('Error fetching meeting:', error);
    return NextResponse.json({ error: 'Failed to fetch meeting' }, { status: 500 });
  }
}

/** PUT /api/membership/meetings/{id} — full update (same body as POST). */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id } = await params;
    const meetingId = parseId(id);
    if (meetingId === null) {
      return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
    }

    const bookGuid = await getActiveBookGuid();
    const body = await request.json().catch(() => null);
    const input = parseInput(meetingInputSchema, body);
    const meeting = await updateMeeting(bookGuid, meetingId, input);
    if (!meeting) {
      return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
    }
    return NextResponse.json(meeting);
  } catch (error) {
    if (error instanceof MembershipValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error updating meeting:', error);
    return NextResponse.json({ error: 'Failed to update meeting' }, { status: 500 });
  }
}

/** DELETE /api/membership/meetings/{id} — attendance cascades. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id } = await params;
    const meetingId = parseId(id);
    if (meetingId === null) {
      return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
    }

    const bookGuid = await getActiveBookGuid();
    const result = await deleteMeeting(bookGuid, meetingId);
    if (!result) {
      return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error deleting meeting:', error);
    return NextResponse.json({ error: 'Failed to delete meeting' }, { status: 500 });
  }
}
