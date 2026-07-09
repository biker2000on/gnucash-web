// src/app/api/business/jobs/route.ts
//
// Job list + create. A job belongs to a customer (owner_type=2) or a vendor
// (owner_type=4). Unscoped like the other native business tables.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  listJobs,
  createJob,
  jobInputSchema,
  parseInput,
  BusinessValidationError,
  type JobListOptions,
} from '@/lib/services/business.service';

/**
 * GET /api/business/jobs
 * Query params: owner (customer/vendor guid), search, active (active|inactive|all).
 */
export async function GET(request: Request) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const activeParam = searchParams.get('active');
    const options: JobListOptions = {
      ownerGuid: searchParams.get('owner')?.trim() || undefined,
      search: searchParams.get('search')?.trim() || undefined,
      active: activeParam === 'active' || activeParam === 'inactive' ? activeParam : 'all',
    };

    return NextResponse.json(await listJobs(options));
  } catch (error) {
    console.error('Error listing jobs:', error);
    return NextResponse.json({ error: 'Failed to list jobs' }, { status: 500 });
  }
}

/**
 * POST /api/business/jobs
 * Body: { name, reference?, active?, ownerType: 'customer'|'vendor', ownerGuid }.
 */
export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json().catch(() => null);
    const input = parseInput(jobInputSchema, body);
    const job = await createJob(input);
    return NextResponse.json(job, { status: 201 });
  } catch (error) {
    if (error instanceof BusinessValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error creating job:', error);
    return NextResponse.json({ error: 'Failed to create job' }, { status: 500 });
  }
}
