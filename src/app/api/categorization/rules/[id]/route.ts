import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { isAccountInActiveBook } from '@/lib/book-scope';
import {
  updateRule,
  deleteRule,
  validateRuleFields,
  type UpdateRulePatch,
  type MatchType,
} from '@/lib/services/categorization.service';

/**
 * PUT /api/categorization/rules/{id}
 * Updates a rule. Body: any of { pattern, matchType, accountGuid, priority, enabled }.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: idParam } = await params;
    const id = parseInt(idParam, 10);
    if (!Number.isInteger(id)) {
      return NextResponse.json({ error: 'Invalid rule id' }, { status: 400 });
    }

    const body = await request.json();
    const fieldError = validateRuleFields({
      pattern: body.pattern,
      matchType: body.matchType,
      priority: body.priority,
    });
    if (fieldError) {
      return NextResponse.json({ error: fieldError }, { status: 400 });
    }

    const patch: UpdateRulePatch = {};
    if ('pattern' in body) patch.pattern = String(body.pattern).trim();
    if ('matchType' in body) patch.matchType = body.matchType as MatchType;
    if ('priority' in body) patch.priority = body.priority;
    if ('enabled' in body) patch.enabled = Boolean(body.enabled);
    if ('accountGuid' in body) {
      const accountGuid = String(body.accountGuid || '');
      if (!accountGuid || !(await isAccountInActiveBook(accountGuid))) {
        return NextResponse.json(
          { error: 'accountGuid does not belong to the active book' },
          { status: 400 },
        );
      }
      patch.accountGuid = accountGuid;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const updated = await updateRule(roleResult.bookGuid, id, patch);
    if (!updated) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error('Error updating categorization rule:', error);
    return NextResponse.json({ error: 'Failed to update rule' }, { status: 500 });
  }
}

/**
 * DELETE /api/categorization/rules/{id}
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: idParam } = await params;
    const id = parseInt(idParam, 10);
    if (!Number.isInteger(id)) {
      return NextResponse.json({ error: 'Invalid rule id' }, { status: 400 });
    }

    const deleted = await deleteRule(roleResult.bookGuid, id);
    if (!deleted) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting categorization rule:', error);
    return NextResponse.json({ error: 'Failed to delete rule' }, { status: 500 });
  }
}
