import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { listAuditEntries, type AuditAction, type EntityType } from '@/lib/services/audit.service';

const ENTITY_TYPES: EntityType[] = ['TRANSACTION', 'ACCOUNT', 'SPLIT', 'PRICE', 'BUDGET', 'SCHEDULED_TRANSACTION', 'TAG', 'INVOICE'];
const ACTIONS: AuditAction[] = ['CREATE', 'UPDATE', 'DELETE'];

/**
 * GET /api/audit?limit&offset&entityType&action&entityGuid
 * Change history for the book's data. Auth: edit (mutating users can see
 * the mutation history; readonly users cannot).
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const entityTypeParam = searchParams.get('entityType');
    const actionParam = searchParams.get('action');

    const result = await listAuditEntries({
      limit: parseInt(searchParams.get('limit') ?? '50', 10) || 50,
      offset: parseInt(searchParams.get('offset') ?? '0', 10) || 0,
      entityType: ENTITY_TYPES.includes(entityTypeParam as EntityType) ? (entityTypeParam as EntityType) : undefined,
      action: ACTIONS.includes(actionParam as AuditAction) ? (actionParam as AuditAction) : undefined,
      entityGuid: searchParams.get('entityGuid') ?? undefined,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error listing audit entries:', error);
    return NextResponse.json({ error: 'Failed to list audit entries' }, { status: 500 });
  }
}
