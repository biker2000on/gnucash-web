/**
 * AI insurance-policy parsing from a vault document.
 *
 * GET  -> { configured: boolean }   (probe: whether an AI provider is set up,
 *          same pattern as /api/ai/parse-transaction)
 * POST -> { documentId } -> { suggestion }
 *
 * The server loads the single referenced document from the entity document
 * vault (book-ownership enforced by the service), sends it to the configured
 * vision model, and returns a parsed suggestion WITHOUT saving anything —
 * the client prefills the policy form for the user to review and save.
 * Policy numbers are masked to their last 4 characters, matching the
 * claims-package export.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getAiConfig } from '@/lib/ai-config';
import { isAiConfigured } from '@/lib/ai-query/client';
import {
  getEntityDocumentFile,
  EntityDocumentNotFoundError,
} from '@/lib/services/entity-documents.service';
import { extractInsurancePolicyDocument } from '@/lib/resilience/insurance-parse';

const NOT_CONFIGURED_MESSAGE =
  'AI is not configured. Set up a provider under Settings → AI to parse policy documents.';

export async function GET() {
  try {
    const auth = await requireRole('readonly');
    if (auth instanceof NextResponse) return auth;
    const config = await getAiConfig(auth.user.id);
    return NextResponse.json({ configured: isAiConfigured(config) });
  } catch (error) {
    console.error('insurance parse config check error:', error);
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
      const suggestion = await extractInsurancePolicyDocument({
        buffer: file.buffer,
        mimeType: file.mimeType,
        aiConfig: config,
      });
      return NextResponse.json({ suggestion });
    } catch (err) {
      console.error('insurance policy AI parse failed:', err);
      const message = err instanceof Error && err.name === 'TimeoutError'
        ? 'The AI request timed out — try again.'
        : 'Could not parse that document with the configured AI provider. Enter the policy details manually.';
      return NextResponse.json({ error: message }, { status: 502 });
    }
  } catch (error) {
    console.error('insurance parse error:', error);
    return NextResponse.json({ error: 'Failed to parse the policy document' }, { status: 500 });
  }
}
