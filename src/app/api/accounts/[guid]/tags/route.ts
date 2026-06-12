import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { isAccountInActiveBook } from '@/lib/book-scope';
import { getAccountTags, setAccountTags } from '@/lib/services/tag.service';

/**
 * GET /api/accounts/{guid}/tags
 * Returns the tags assigned to an account.
 */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        if (!await isAccountInActiveBook(guid)) {
            return NextResponse.json({ error: 'Account not found' }, { status: 404 });
        }

        return NextResponse.json(await getAccountTags(guid));
    } catch (error) {
        console.error('Error fetching account tags:', error);
        return NextResponse.json({ error: 'Failed to fetch account tags' }, { status: 500 });
    }
}

/**
 * PUT /api/accounts/{guid}/tags
 * Replaces the account's full tag list. Body: { tags: string[] } (tag names;
 * created on the fly when they don't exist yet).
 */
export async function PUT(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        if (!await isAccountInActiveBook(guid)) {
            return NextResponse.json({ error: 'Account not found' }, { status: 404 });
        }

        const body = await request.json();
        if (!Array.isArray(body.tags)) {
            return NextResponse.json({ error: 'Body must include a "tags" array of tag names' }, { status: 400 });
        }

        try {
            const tags = await setAccountTags(guid, body.tags);
            return NextResponse.json(tags);
        } catch (err) {
            if (err instanceof Error && err.message.startsWith('Invalid tag name')) {
                return NextResponse.json({ error: err.message }, { status: 400 });
            }
            throw err;
        }
    } catch (error) {
        console.error('Error setting account tags:', error);
        return NextResponse.json({ error: 'Failed to set account tags' }, { status: 500 });
    }
}
