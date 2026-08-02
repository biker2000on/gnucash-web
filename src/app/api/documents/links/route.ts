import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  DocumentNotFoundError,
  DocumentValidationError,
  ensureCanonicalDocumentPlatform,
  linkDocument,
  listLinkedDocuments,
  validateDocumentBookScope,
  type DocumentJson,
  type DocumentLinkRole,
  type DocumentTargetType,
  type LinkedDocument,
} from '@/lib/documents';
import {
  DocumentLinkTargetValidationError,
  isDocumentLinkTargetType,
  validateDocumentLinkTarget,
} from '@/lib/services/document-link-targets.service';

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof DocumentNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof DocumentLinkTargetValidationError) {
    const status = /not found in this book/i.test(error.message) ? 404 : 400;
    return NextResponse.json({ error: error.message }, { status });
  }
  if (error instanceof DocumentValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  console.error(fallback, error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

function positiveInt(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function metadata(value: unknown): DocumentJson | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DocumentValidationError('metadata must be an object');
  }
  return value as DocumentJson;
}

/** JSON-safe, least-privilege projection for generic linked-document UIs. */
export function serializeDocumentLink(link: LinkedDocument['link']) {
  return {
    id: link.id,
    documentId: link.documentId,
    targetType: link.targetType,
    targetId: link.targetId,
    role: link.role,
    metadata: link.metadata,
    createdAt: link.createdAt.toISOString(),
  };
}

export function serializeLinkedDocument(value: LinkedDocument) {
  const { document, link } = value;
  const extraction = document.extractionMetadata ?? {};
  return {
    link: serializeDocumentLink(link),
    document: {
      id: document.id,
      title: document.title,
      filename: document.filename,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes == null ? null : Number(document.sizeBytes),
      sourceKind: document.sourceKind,
      sourceId: document.sourceId,
      extractionStatus: document.extractionStatus,
      extractionSummary: {
        hasText: Boolean(document.extractedText),
        hasError: Boolean(document.extractionError),
        extractedAt: document.extractedAt?.toISOString() ?? null,
        characterCount: typeof extraction.characterCount === 'number'
          ? extraction.characterCount
          : document.extractedText?.length ?? 0,
        suggestionKind: typeof extraction.suggestionKind === 'string'
          ? extraction.suggestionKind
          : null,
      },
      createdAt: document.createdAt.toISOString(),
      updatedAt: document.updatedAt.toISOString(),
    },
  };
}

/** GET /api/documents/links?targetType=&targetId= */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const targetType = request.nextUrl.searchParams.get('targetType');
    const targetId = request.nextUrl.searchParams.get('targetId');
    if (!isDocumentLinkTargetType(targetType) || !targetId) {
      return NextResponse.json({ error: 'targetType and targetId are required' }, { status: 400 });
    }

    await ensureCanonicalDocumentPlatform();
    await validateDocumentLinkTarget(roleResult.bookGuid, {
      targetType,
      targetId,
      userId: roleResult.user.id,
    });
    const links = await listLinkedDocuments({
      bookGuid: roleResult.bookGuid,
      targetType: targetType as DocumentTargetType,
      targetId,
    });
    return NextResponse.json({ links: links.map(serializeLinkedDocument) });
  } catch (error) {
    return errorResponse(error, 'Failed to list document links');
  }
}

/** POST /api/documents/links — attach a canonical document to a typed target. */
export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const documentId = positiveInt(body?.documentId);
    const targetType = body?.targetType;
    const targetId = typeof body?.targetId === 'string' ? body.targetId : '';
    const role = typeof body?.role === 'string' ? body.role : '';
    if (!documentId || !isDocumentLinkTargetType(targetType) || !targetId || !role) {
      return NextResponse.json({ error: 'documentId, targetType, targetId, and role are required' }, { status: 400 });
    }

    await ensureCanonicalDocumentPlatform();
    await validateDocumentBookScope(roleResult.bookGuid, documentId);
    await validateDocumentLinkTarget(roleResult.bookGuid, {
      targetType,
      targetId,
      role,
      userId: roleResult.user.id,
    });
    const link = await linkDocument({
      bookGuid: roleResult.bookGuid,
      documentId,
      targetType: targetType as DocumentTargetType,
      targetId,
      role: role as DocumentLinkRole,
      metadata: metadata(body?.metadata),
      createdBy: roleResult.user.id,
    });
    return NextResponse.json({ link: serializeDocumentLink(link) }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 'Failed to create document link');
  }
}
