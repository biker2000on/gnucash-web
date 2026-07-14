// src/app/api/membership/meetings/[id]/attendance/route.ts
//
// Bulk replace-all attendance for a meeting (the roll-call save).

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import {
  setAttendance,
  attendanceEntriesSchema,
  parseInput,
  MembershipValidationError,
} from '@/lib/services/membership.service';

/**
 * PUT /api/membership/meetings/{id}/attendance
 * Body: { entries: [{ memberId, status: present|absent|excused, notes? }] }.
 * Replace-all semantics: members omitted from entries lose their record.
 * Returns the refreshed meeting detail (with roster).
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id } = await params;
    const meetingId = Number.parseInt(id, 10);
    if (!Number.isInteger(meetingId) || meetingId <= 0) {
      return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
    }

    const bookGuid = await getActiveBookGuid();
    const body = await request.json().catch(() => null);
    const input = parseInput(attendanceEntriesSchema, body);
    const meeting = await setAttendance(bookGuid, meetingId, input);
    if (!meeting) {
      return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
    }
    return NextResponse.json(meeting);
  } catch (error) {
    if (error instanceof MembershipValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error saving attendance:', error);
    return NextResponse.json({ error: 'Failed to save attendance' }, { status: 500 });
  }
}
