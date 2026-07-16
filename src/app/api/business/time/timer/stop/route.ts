// src/app/api/business/time/timer/stop/route.ts
//
// Stop the calling user's running timer: adds the elapsed whole minutes to
// the entry and clears timer_started_at. 409 when nothing is running.

import { NextResponse } from 'next/server';
import { requireTimesheetRole } from '@/lib/auth';
import { stopTimer } from '@/lib/business/time-tracking.service';
import { mapTimeTrackingError } from '@/lib/business/time-tracking-errors';

/** POST /api/business/time/timer/stop */
export async function POST() {
  try {
    // Timers are inherently per-user; timekeepers may stop their own.
    const roleResult = await requireTimesheetRole('write');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const entry = await stopTimer(bookGuid, user.id);
    return NextResponse.json(entry);
  } catch (error) {
    return mapTimeTrackingError(error, 'stopping a timer');
  }
}
