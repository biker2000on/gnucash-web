// src/app/api/business/time/[id]/route.ts
//
// Single time entry: read / partial update / delete. Invoiced entries are
// immutable (409 from the service).
//
// Access: requireTimesheetRole. Timekeepers are scoped to their OWN entries —
// another user's entry id returns 404 (never 403, to avoid confirming that
// the id exists). readonly may read any entry; edit/admin may modify any.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTimesheetRole } from '@/lib/auth';
import { parseInput, BusinessValidationError } from '@/lib/services/business.service';
import {
  getTimeEntry,
  updateTimeEntry,
  deleteTimeEntry,
} from '@/lib/business/time-tracking.service';
import { mapTimeTrackingError } from '@/lib/business/time-tracking-errors';

const GUID_RE = /^[0-9a-f]{32}$/;

const patchSchema = z.object({
  customerGuid: z.string().regex(GUID_RE).nullish(),
  jobGuid: z.string().regex(GUID_RE).nullish(),
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  minutes: z.number().int().min(0).optional(),
  rate: z.number().min(0).nullish(),
  description: z.string().max(4096).optional(),
  billable: z.boolean().optional(),
});

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** GET /api/business/time/{id} */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireTimesheetRole('read');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid, isTimekeeper } = roleResult;

    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    const entry = await getTimeEntry(bookGuid, id, isTimekeeper ? { userId: user.id } : undefined);
    if (!entry) return NextResponse.json({ error: 'Time entry not found' }, { status: 404 });
    return NextResponse.json(entry);
  } catch (error) {
    return mapTimeTrackingError(error, 'fetching a time entry');
  }
}

/** PATCH /api/business/time/{id} — partial update (rate: null clears it). */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireTimesheetRole('write');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid, isTimekeeper } = roleResult;

    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    const body = await request.json().catch(() => null);
    const patch = parseInput(patchSchema, body);
    const entry = await updateTimeEntry(
      bookGuid,
      id,
      patch,
      isTimekeeper ? { userId: user.id } : undefined,
    );
    return NextResponse.json(entry);
  } catch (error) {
    if (error instanceof BusinessValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return mapTimeTrackingError(error, 'updating a time entry');
  }
}

/** DELETE /api/business/time/{id} */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireTimesheetRole('write');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid, isTimekeeper } = roleResult;

    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    await deleteTimeEntry(bookGuid, id, isTimekeeper ? { userId: user.id } : undefined);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return mapTimeTrackingError(error, 'deleting a time entry');
  }
}
