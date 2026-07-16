// src/app/api/business/time/route.ts
//
// Time tracking: list/create timesheet entries. GET also serves the
// unbilled-per-customer summary via ?view=unbilled, and always includes the
// caller's running timer so the page needs a single fetch.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
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
 *   ?view=unbilled                       -> { unbilled: UnbilledCustomerGroup[] }
 *   ?startDate=&endDate=&customer=&job=  -> { entries, runningTimer }
 */
export async function GET(request: Request) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const { searchParams } = new URL(request.url);
    if (searchParams.get('view') === 'unbilled') {
      return NextResponse.json({ unbilled: await getUnbilledSummary(bookGuid) });
    }

    const [entries, runningTimer] = await Promise.all([
      listTimeEntries(bookGuid, {
        startDate: searchParams.get('startDate') ?? undefined,
        endDate: searchParams.get('endDate') ?? undefined,
        customerGuid: searchParams.get('customer') ?? undefined,
        jobGuid: searchParams.get('job') ?? undefined,
      }),
      getRunningTimer(bookGuid, user.id),
    ]);
    return NextResponse.json({ entries, runningTimer });
  } catch (error) {
    return mapTimeTrackingError(error, 'listing time entries');
  }
}

/**
 * POST /api/business/time
 * Body: { customerGuid?, jobGuid?, entryDate, minutes, rate?, description?, billable? }.
 * Omitting rate resolves the default (job rate, else the customer's last rate).
 */
export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('edit');
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
