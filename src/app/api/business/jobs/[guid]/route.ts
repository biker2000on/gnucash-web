// src/app/api/business/jobs/[guid]/route.ts
//
// Single-job read/update/delete. DELETE deactivates when invoices reference
// the job (owner_type=3); otherwise hard-deletes.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  updateJob,
  deleteJob,
  jobInputSchema,
  parseInput,
  BusinessValidationError,
} from '@/lib/services/business.service';
import { getJobEx, updateJobPartial, jobPatchSchema } from '@/lib/business/jobs.service';

/** GET /api/business/jobs/{guid} — includes `rate` (job-rate slot). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const job = await getJobEx(guid);
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    return NextResponse.json(job);
  } catch (error) {
    console.error('Error fetching job:', error);
    return NextResponse.json({ error: 'Failed to fetch job' }, { status: 500 });
  }
}

/**
 * PATCH /api/business/jobs/{guid} — partial update. Any of
 * { name?, reference?, active?, ownerType?, ownerGuid?, rate? };
 * rate: null clears the job-rate slot.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const body = await request.json().catch(() => null);
    const patch = parseInput(jobPatchSchema, body);
    const job = await updateJobPartial(guid, patch);
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    return NextResponse.json(job);
  } catch (error) {
    if (error instanceof BusinessValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error updating job:', error);
    return NextResponse.json({ error: 'Failed to update job' }, { status: 500 });
  }
}

/** PUT /api/business/jobs/{guid} — full update (same body as POST). */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const body = await request.json().catch(() => null);
    const input = parseInput(jobInputSchema, body);
    const job = await updateJob(guid, input);
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    return NextResponse.json(job);
  } catch (error) {
    if (error instanceof BusinessValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error updating job:', error);
    return NextResponse.json({ error: 'Failed to update job' }, { status: 500 });
  }
}

/**
 * DELETE /api/business/jobs/{guid}
 * Hard-deletes only when unreferenced; otherwise sets active=0.
 * Returns { deleted, deactivated }.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const result = await deleteJob(guid);
    if (!result) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error deleting job:', error);
    return NextResponse.json({ error: 'Failed to delete job' }, { status: 500 });
  }
}
