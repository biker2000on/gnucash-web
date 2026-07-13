import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    createShareLink,
    listShareLinks,
    normalizeExpiryDays,
    parseShareSections,
    type ShareLinkRecord,
} from '@/lib/share-links';

function serializeLink(l: ShareLinkRecord) {
    return {
        id: l.id,
        label: l.label,
        prefix: l.prefix,
        sections: l.sections,
        expiresAt: l.expiresAt.toISOString(),
        createdAt: l.createdAt.toISOString(),
        viewCount: l.viewCount,
        expired: l.expiresAt.getTime() <= Date.now(),
    };
}

/** GET /api/settings/share-links — list the current user's links for the active book. */
export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const links = await listShareLinks(roleResult.user.id, roleResult.bookGuid);
        return NextResponse.json({ links: links.map(serializeLink) });
    } catch (error) {
        console.error('Error listing share links:', error);
        return NextResponse.json({ error: 'Failed to list share links' }, { status: 500 });
    }
}

/**
 * POST /api/settings/share-links — create a share link for the active book.
 * Body: { label, expiryDays: 7|30|90, sections: string[] }
 * Returns the plaintext URL exactly once. Admin only — a share link exposes
 * the whole book's summary reports to anyone holding the URL.
 */
export async function POST(request: NextRequest) {
    try {
        const roleResult = await requireRole('admin');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json().catch(() => null);
        if (!body || typeof body.label !== 'string' || !body.label.trim()) {
            return NextResponse.json({ error: 'A label is required' }, { status: 400 });
        }

        const expiryDays = normalizeExpiryDays(body.expiryDays);
        const expiresAt = new Date(Date.now() + expiryDays * 86400_000);
        const sections = parseShareSections(body.sections);

        const { link, secret } = await createShareLink(roleResult.user.id, {
            bookGuid: roleResult.bookGuid,
            label: body.label,
            expiresAt,
            sections,
        });

        return NextResponse.json(
            { link: serializeLink(link), secret, url: `/share/${secret}` },
            { status: 201 },
        );
    } catch (error) {
        console.error('Error creating share link:', error);
        return NextResponse.json({ error: 'Failed to create share link' }, { status: 500 });
    }
}
