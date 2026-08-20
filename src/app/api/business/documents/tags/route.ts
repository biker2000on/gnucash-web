import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { listDocumentTagVocabulary } from '@/lib/documents/document-tags';

/**
 * GET /api/business/documents/tags → { tags: [{ name, count }] }
 *
 * Book-scoped shared vocabulary (`gnucash_web_tags`) with per-tag counts of
 * vault documents that currently carry the tag.
 */
export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const tags = await listDocumentTagVocabulary(bookGuid);
        return NextResponse.json({ tags });
    } catch (error) {
        console.error('Error listing document tag vocabulary:', error);
        return NextResponse.json({ error: 'Failed to list document tags' }, { status: 500 });
    }
}
