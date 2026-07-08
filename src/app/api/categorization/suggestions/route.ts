import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { suggestRules } from '@/lib/services/categorization.service';

/**
 * GET /api/categorization/suggestions
 * Learned rule candidates from transaction history: normalized descriptions
 * seen >= 3 times where >= 80% of occurrences share one counterpart
 * expense/income account and no existing rule already covers them.
 */
export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const suggestions = await suggestRules(roleResult.bookGuid);
    return NextResponse.json(suggestions);
  } catch (error) {
    console.error('Error computing categorization suggestions:', error);
    return NextResponse.json({ error: 'Failed to compute suggestions' }, { status: 500 });
  }
}
