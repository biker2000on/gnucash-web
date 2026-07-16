// src/app/api/business/time/route.ts
//
// Time tracking: list/create timesheet entries. GET also serves the
// unbilled-per-customer summary via ?view=unbilled, and always includes the
// caller's running timer so the page needs a single fetch.
//
// Access: requireTimesheetRole — readonly may read, timekeeper/edit/admin may
// write. Timekeepers are FORCED to their own entries (list and create);
// edit/admin see every user's entries and may filter with ?userId=. The
// unbilled summary is financial data and is not served to timekeepers.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTimesheetRole } from '@/lib/auth';
import { parseInput, BusinessValidationError } from '@/lib/services/business.service';
import {
  listTimeEntries,
  createTimeEntry,
  getRunningTimer,
  getUnbilledSummary,
} from '@/lib/business/time-tracking.service';
import { mapTimeTrackingError } from '@/lib/business/time-tracking-errors';

const GUID_RE = /^[0-9a-f]{32}$/;

const createSchema = z.object({
  customerGuid: z.string().regex(GUID_RE).nullish(),
  jobGuid: z.string().regex(GUID_RE).nullish(),
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  minutes: z.number().int().min(0),
  rate: z.number().min(0).nullish(),
  description: z.string().max(4096).optional(),
  billable: z.boolean().optional(),
});

/**
 * GET /api/business/time
 *   ?view=unbilled                                -> { unbilled } (not timekeepers)
 *   ?startDate=&endDate=&customer=&job=&userId=   -> { entries, runningTimer, isTimekeeper }
 */
export async function GET(request: Request) {
  try {
    const roleResult = await requireTimesheetRole('read');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid, isTimekeeper } = roleResult;

    const { searchParams } = new URL(request.url);
    if (searchParams.get('view') === 'unbilled') {
      if (isTimekeeper) {
        return NextResponse.json(
          { error: 'Timekeepers cannot view unbilled amounts' },
          { status: 403 }
        );
      }
      return NextResponse.json({ unbilled: await getUnbilledSummary(bookGuid) });
    }

    // Scoping: timekeepers ONLY ever see their own entries; other roles may
    // optionally narrow to one user with ?userId=.
    let userIdFilter: number | undefined;
    if (isTimekeeper) {
      userIdFilter = user.id;
    } else {
      const rawUserId = searchParams.get('userId');
      if (rawUserId != null && rawUserId !== '') {
        const parsed = Number(rawUserId);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return NextResponse.json({ error: 'Invalid userId filter' }, { status: 400 });
        }
        userIdFilter = parsed;
      }
    }

    const [entries, runningTimer] = await Promise.all([
      listTimeEntries(bookGuid, {
        startDate: searchParams.get('startDate') ?? undefined,
        endDate: searchParams.get('endDate') ?? undefined,
        customerGuid: searchParams.get('customer') ?? undefined,
        jobGuid: searchParams.get('job') ?? undefined,
        userId: userIdFilter,
      }),
      getRunningTimer(bookGuid, user.id),
    ]);
    return NextResponse.json({ entries, runningTimer, isTimekeeper });
  } catch (error) {
    return mapTimeTrackingError(error, 'listing time entries');
  }
}

/**
 * POST /api/business/time
 * Body: { customerGuid?, jobGuid?, entryDate, minutes, rate?, description?, billable? }.
 * Omitting rate resolves the default (job rate, else the customer's last rate).
 * Entries are always created as the calling user.
 */
export async function POST(request: Request) {
  try {
    const roleResult = await requireTimesheetRole('write');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const body = await request.json().catch(() => null);
    // zod .nullish() preserves the absent-vs-null distinction: an omitted
    // rate stays undefined (resolve the default), an explicit null clears it.
    const input = parseInput(createSchema, body);
    const entry = await createTimeEntry(bookGuid, user.id, input);
    return NextResponse.json(entry, { status: 201 });
  } catch (error) {
    if (error instanceof BusinessValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return mapTimeTrackingError(error, 'creating a time entry');
  }
}
