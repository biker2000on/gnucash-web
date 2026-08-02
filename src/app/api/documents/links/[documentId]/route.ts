import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  DocumentNotFoundError,
  DocumentValidationError,
  ensureCanonicalDocumentPlatform,
  unlinkDocument,
  validateDocumentBookScope,
  type DocumentLinkRole,
  type DocumentTargetType,
} from '@/lib/documents';
import {
  DocumentLinkTargetValidationError,
  isDocumentLinkTargetType,
  validateDocumentLinkTarget,
} from '@/lib/services/document-link-targets.service';

type RouteParams = { params: Promise<{ documentId: string }> };

function parseDocumentId(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function failure(error: unknown) {
  if (error instanceof DocumentNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
  if (error instanceof DocumentLinkTargetValidationError) {
    return NextResponse.json({ error: error.message }, { status: /not found in this book/i.test(error.message) ? 404 : 400 });
  }
  if (error instanceof DocumentValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
  console.error('Failed to delete document link', error);
  return NextResponse.json({ error: 'Failed to delete document link' }, { status: 500 });
}

/** DELETE /api/documents/links/{documentId} body: { targetType, targetId, role }. */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const documentId = parseDocumentId((await params).documentId);
    if (!documentId) return NextResponse.json({ error: 'Invalid document ID' }, { status: 400 });

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const targetType = body?.targetType;
    const targetId = typeof body?.targetId === 'string' ? body.targetId : '';
    const role = typeof body?.role === 'string' ? body.role : '';
    if (!isDocumentLinkTargetType(targetType) || !targetId || !role) {
      return NextResponse.json({ error: 'targetType, targetId, and role are required' }, { status: 400 });
    }

    await ensureCanonicalDocumentPlatform();
    await validateDocumentBookScope(roleResult.bookGuid, documentId);
    await validateDocumentLinkTarget(roleResult.bookGuid, {
      targetType,
      targetId,
      role,
      userId: roleResult.user.id,
    });
    const deleted = await unlinkDocument({
      bookGuid: roleResult.bookGuid,
      documentId,
      targetType: targetType as DocumentTargetType,
      targetId,
      role: role as DocumentLinkRole,
    });
    if (!deleted) return NextResponse.json({ error: 'Document link not found' }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return failure(error);
  }
}
