/**
 * AI estate-document parsing from a vault document.
 *
 * GET  -> { configured: boolean }   (probe: whether an AI provider is set up,
 *          same pattern as /api/resilience/insurance/parse)
 * POST -> { documentId } -> { suggestion }
 *
 * The server loads the single referenced document from the entity document
 * vault (book-ownership enforced by the service), sends it to the configured
 * vision model, and returns a parsed suggestion WITHOUT saving anything — the
 * client prefills the estate-document form for the user to review and save.
 * The extracted principal is matched against the household roster so the form
 * can preselect the right person; an unconfident match returns memberRole null.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getAiConfig } from '@/lib/ai-config';
import { isAiConfigured } from '@/lib/ai-query/client';
import { query } from '@/lib/db';
import {
  getEntityDocumentFile,
  EntityDocumentNotFoundError,
} from '@/lib/services/entity-documents.service';
import { extractEstateDocument, matchEstateMemberRole } from '@/lib/resilience/estate-parse';

const NOT_CONFIGURED_MESSAGE =
  'AI is not configured. Set up a provider under Settings → AI to parse estate documents.';

/** Household roster (self/spouse/dependent) for principal-name matching. */
async function loadRoster(bookGuid: string): Promise<Array<{ role: string; name: string }>> {
  try {
    const result = await query(
      `SELECT role, COALESCE(name, '') AS name
         FROM gnucash_web_entity_members
        WHERE book_guid = $1
          AND role IN ('self', 'spouse', 'dependent')
        ORDER BY sort_order ASC, id ASC`,
      [bookGuid],
    );
    return result.rows as Array<{ role: string; name: string }>;
  } catch {
    return [];
  }
}

export async function GET() {
  try {
    const auth = await requireRole('readonly');
    if (auth instanceof NextResponse) return auth;
    const config = await getAiConfig(auth.user.id);
    return NextResponse.json({ configured: isAiConfigured(config) });
  } catch (error) {
    console.error('estate parse config check error:', error);
    return NextResponse.json({ configured: false });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole('edit');
    if (auth instanceof NextResponse) return auth;

    const body = await request.json().catch(() => null) as { documentId?: unknown } | null;
    const documentId = Number(body?.documentId);
    if (!Number.isInteger(documentId) || documentId <= 0) {
      return NextResponse.json({ error: 'documentId is required' }, { status: 400 });
    }

    const config = await getAiConfig(auth.user.id);
    if (!isAiConfigured(config)) {
      return NextResponse.json({ error: NOT_CONFIGURED_MESSAGE }, { status: 400 });
    }

    let file;
    try {
      file = await getEntityDocumentFile(auth.bookGuid, documentId);
    } catch (error) {
      if (error instanceof EntityDocumentNotFoundError) {
        return NextResponse.json({ error: 'Document not found' }, { status: 404 });
      }
      throw error;
    }

    try {
      const suggestion = await extractEstateDocument({
        buffer: file.buffer,
        mimeType: file.mimeType,
        aiConfig: config,
      });
      const match = matchEstateMemberRole(suggestion.principalName, await loadRoster(auth.bookGuid));
      return NextResponse.json({
        suggestion: {
          ...suggestion,
          memberRole: match?.memberRole ?? null,
          memberName: match?.memberName ?? null,
        },
      });
    } catch (err) {
      console.error('estate document AI parse failed:', err);
      const message = err instanceof Error && err.name === 'TimeoutError'
        ? 'The AI request timed out — try again.'
        : 'Could not parse that document with the configured AI provider. Enter the document details manually.';
      return NextResponse.json({ error: message }, { status: 502 });
    }
  } catch (error) {
    console.error('estate parse error:', error);
    return NextResponse.json({ error: 'Failed to parse the estate document' }, { status: 500 });
  }
}
