// src/app/api/membership/meetings/route.ts
//
// Meeting list (date desc, with attendance counts) + create.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import {
  listMeetings,
  createMeeting,
  meetingInputSchema,
  parseInput,
  MembershipValidationError,
} from '@/lib/services/membership.service';

/** GET /api/membership/meetings */
export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const bookGuid = await getActiveBookGuid();
    return NextResponse.json(await listMeetings(bookGuid));
  } catch (error) {
    console.error('Error listing meetings:', error);
    return NextResponse.json({ error: 'Failed to list meetings' }, { status: 500 });
  }
}

/**
 * POST /api/membership/meetings
 * Body: { title, meetingDate, location?, notes? }.
 */
export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const bookGuid = await getActiveBookGuid();
    const body = await request.json().catch(() => null);
    const input = parseInput(meetingInputSchema, body);
    const meeting = await createMeeting(bookGuid, input);
    return NextResponse.json(meeting, { status: 201 });
  } catch (error) {
    if (error instanceof MembershipValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error creating meeting:', error);
    return NextResponse.json({ error: 'Failed to create meeting' }, { status: 500 });
  }
}
