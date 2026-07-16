// src/app/api/business/time/timer/start/route.ts
//
// Start a timer for the calling user in the active book. Only one running
// timer per user per book — a second start returns 409.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTimesheetRole } from '@/lib/auth';
import { parseInput, BusinessValidationError } from '@/lib/services/business.service';
import { startTimer } from '@/lib/business/time-tracking.service';
import { mapTimeTrackingError } from '@/lib/business/time-tracking-errors';

const GUID_RE = /^[0-9a-f]{32}$/;

const startSchema = z.object({
  customerGuid: z.string().regex(GUID_RE).nullish(),
  jobGuid: z.string().regex(GUID_RE).nullish(),
  description: z.string().max(4096).optional(),
});

/** POST /api/business/time/timer/start — body: { customerGuid?, jobGuid?, description? }. */
export async function POST(request: Request) {
  try {
    // Timers are inherently per-user; timekeepers may run their own.
    const roleResult = await requireTimesheetRole('write');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const body = await request.json().catch(() => ({}));
    const input = parseInput(startSchema, body ?? {});
    const entry = await startTimer(bookGuid, user.id, input);
    return NextResponse.json(entry, { status: 201 });
  } catch (error) {
    if (error instanceof BusinessValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return mapTimeTrackingError(error, 'starting a timer');
  }
}
