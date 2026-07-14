// src/app/api/membership/summary/route.ts
//
// Dashboard numbers for the members page: dues status counts, YTD dues,
// upcoming expirations, recent-meeting attendance rate.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { membershipSummary } from '@/lib/services/membership.service';

/** GET /api/membership/summary */
export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const bookGuid = await getActiveBookGuid();
    return NextResponse.json(await membershipSummary(bookGuid));
  } catch (error) {
    console.error('Error building membership summary:', error);
    return NextResponse.json({ error: 'Failed to build membership summary' }, { status: 500 });
  }
}
