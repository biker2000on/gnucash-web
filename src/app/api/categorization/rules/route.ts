import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { isAccountInActiveBook } from '@/lib/book-scope';
import {
  listRules,
  createRule,
  validateRuleFields,
  type MatchType,
} from '@/lib/services/categorization.service';

/**
 * GET /api/categorization/rules
 * Lists all categorization rules for the active book.
 */
export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const rules = await listRules(roleResult.bookGuid);
    return NextResponse.json(rules);
  } catch (error) {
    console.error('Error listing categorization rules:', error);
    return NextResponse.json({ error: 'Failed to list rules' }, { status: 500 });
  }
}

/**
 * POST /api/categorization/rules
 * Creates a rule. Body: { pattern, matchType, accountGuid, priority?, enabled? }.
 */
export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    const pattern = typeof body.pattern === 'string' ? body.pattern.trim() : '';
    const matchType = body.matchType ?? 'contains';
    const accountGuid = typeof body.accountGuid === 'string' ? body.accountGuid : '';

    const fieldError = validateRuleFields({ pattern, matchType, priority: body.priority });
    if (fieldError) {
      return NextResponse.json({ error: fieldError }, { status: 400 });
    }
    if (!pattern) {
      return NextResponse.json({ error: 'pattern is required' }, { status: 400 });
    }
    if (!accountGuid) {
      return NextResponse.json({ error: 'accountGuid is required' }, { status: 400 });
    }
    if (!(await isAccountInActiveBook(accountGuid))) {
      return NextResponse.json(
        { error: 'accountGuid does not belong to the active book' },
        { status: 400 },
      );
    }

    const rule = await createRule(roleResult.bookGuid, {
      pattern,
      matchType: matchType as MatchType,
      accountGuid,
      priority: body.priority ?? 0,
      enabled: body.enabled ?? true,
    });

    return NextResponse.json(rule, { status: 201 });
  } catch (error) {
    console.error('Error creating categorization rule:', error);
    return NextResponse.json({ error: 'Failed to create rule' }, { status: 500 });
  }
}
