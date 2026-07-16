import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getHomeSummary } from '@/lib/services/home.service';
import { handleHomeError } from '../_lib';

/**
 * GET /api/home/summary — per-room counts + value subtotals, total insured
 * value, warranty alerts (expired / ≤90d), task overdue/upcoming counts,
 * and YTD maintenance cost.
 */
export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const summary = await getHomeSummary(bookGuid);
        return NextResponse.json(summary);
    } catch (error) {
        return handleHomeError(error, 'Error building home summary', 'Failed to load summary');
    }
}
