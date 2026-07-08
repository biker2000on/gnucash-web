import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { listEnabledRules, matchRule } from '@/lib/services/categorization.service';

/**
 * GET /api/categorization/test?description=...
 * Dry-runs the rules engine against a description. Returns the matched rule
 * (if any) and the resulting account. Rule-only: the history-based fallback
 * used during sync depends on the specific bank account being imported into,
 * which is not known here.
 */
export async function GET(request: Request) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const description = searchParams.get('description') || '';
    if (!description.trim()) {
      return NextResponse.json({ error: 'description is required' }, { status: 400 });
    }

    const rules = await listEnabledRules(roleResult.bookGuid);
    const rule = matchRule(rules, description);

    if (!rule) {
      return NextResponse.json({
        matched: false,
        rule: null,
        accountGuid: null,
        accountName: null,
        note: 'No rule matched. During sync, the history-based guess (then Imbalance) would apply.',
      });
    }

    const account = await prisma.$queryRaw<{ fullname: string }[]>`
      SELECT fullname FROM account_hierarchy WHERE guid = ${rule.accountGuid}
    `;

    return NextResponse.json({
      matched: true,
      rule: {
        id: rule.id,
        pattern: rule.pattern,
        matchType: rule.matchType,
        priority: rule.priority,
      },
      accountGuid: rule.accountGuid,
      accountName: account[0]?.fullname ?? null,
    });
  } catch (error) {
    console.error('Error testing categorization rules:', error);
    return NextResponse.json({ error: 'Failed to test rules' }, { status: 500 });
  }
}
