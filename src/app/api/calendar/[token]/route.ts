import { NextRequest, NextResponse } from 'next/server';
import { resolveCalendarFeedToken } from '@/lib/calendar-tokens';
import { buildCalendarFeed } from '@/lib/ical';

/**
 * GET /api/calendar/[token] — PUBLIC iCal feed (text/calendar).
 *
 * No session: the unguessable token in the URL is the authentication
 * (calendar apps cannot log in). Requires the middleware to pass
 * /api/calendar/ through — see src/middleware.ts:
 *
 *   if (pathname.startsWith('/api/auth/') || pathname.startsWith('/api/calendar/')) {
 *
 * Invalid or revoked tokens return 404 so the endpoint does not confirm
 * token existence.
 */
export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ token: string }> },
) {
    try {
        const { token } = await params;
        const resolved = await resolveCalendarFeedToken(token);
        if (!resolved) {
            return NextResponse.json({ error: 'Not found' }, { status: 404 });
        }

        const ics = await buildCalendarFeed(
            resolved.userId,
            resolved.bookGuid,
            resolved.eventTypes,
        );

        return new NextResponse(ics, {
            status: 200,
            headers: {
                'Content-Type': 'text/calendar; charset=utf-8',
                'Content-Disposition': 'inline; filename="gnucash-web.ics"',
                // Calendar clients poll; keep responses fresh but cacheable briefly.
                'Cache-Control': 'private, max-age=300',
            },
        });
    } catch (error) {
        console.error('Error building calendar feed:', error);
        return NextResponse.json({ error: 'Failed to build calendar feed' }, { status: 500 });
    }
}
