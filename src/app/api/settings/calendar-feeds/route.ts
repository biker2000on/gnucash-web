import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    createCalendarFeedToken,
    listCalendarFeedTokens,
    type CalendarFeedTokenRecord,
} from '@/lib/calendar-tokens';

function serializeFeed(t: CalendarFeedTokenRecord) {
    return {
        id: t.id,
        bookGuid: t.bookGuid,
        prefix: t.prefix,
        eventTypes: t.eventTypes,
        createdAt: t.createdAt.toISOString(),
    };
}

/** GET /api/settings/calendar-feeds — list the current user's feed tokens. */
export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        if (roleResult.viaToken) {
            return NextResponse.json({ error: 'API tokens cannot manage calendar feeds' }, { status: 403 });
        }

        const feeds = await listCalendarFeedTokens(roleResult.user.id);
        return NextResponse.json({ feeds: feeds.map(serializeFeed) });
    } catch (error) {
        console.error('Error listing calendar feeds:', error);
        return NextResponse.json({ error: 'Failed to list calendar feeds' }, { status: 500 });
    }
}

/**
 * POST /api/settings/calendar-feeds — create a feed token for the active book.
 * Body: { eventTypes?: string[] }
 * Returns the plaintext token exactly once; the feed URL is built client-side.
 */
export async function POST(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        if (roleResult.viaToken) {
            return NextResponse.json({ error: 'API tokens cannot manage calendar feeds' }, { status: 403 });
        }

        const body = await request.json().catch(() => null);
        const { token, secret } = await createCalendarFeedToken(
            roleResult.user.id,
            roleResult.bookGuid,
            body?.eventTypes,
        );

        return NextResponse.json({ feed: serializeFeed(token), secret }, { status: 201 });
    } catch (error) {
        console.error('Error creating calendar feed:', error);
        return NextResponse.json({ error: 'Failed to create calendar feed' }, { status: 500 });
    }
}
