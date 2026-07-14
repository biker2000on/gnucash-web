import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { normalizeTagName, isValidTagName, pickTagColor, TAG_COLORS } from '@/lib/tags';

/**
 * GET /api/tags
 * Lists the active book's tags with usage counts (transaction_count, account_count).
 * Optional: ?include=accounts adds account_guids per tag (for the account tree).
 */
export async function GET(request: Request) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const includeAccounts = searchParams.get('include') === 'accounts';
        const bookGuid = await getActiveBookGuid();

        const tags = await prisma.gnucash_web_tags.findMany({
            where: { book_guid: bookGuid },
            orderBy: { name: 'asc' },
            include: {
                _count: {
                    select: { transaction_tags: true, account_tags: true },
                },
                ...(includeAccounts ? {
                    account_tags: { select: { account_guid: true } },
                } : {}),
            },
        });

        const result = tags.map(tag => ({
            id: tag.id,
            name: tag.name,
            color: tag.color,
            description: tag.description,
            created_at: tag.created_at,
            transaction_count: tag._count.transaction_tags,
            account_count: tag._count.account_tags,
            ...(includeAccounts ? {
                account_guids: (tag as unknown as { account_tags: { account_guid: string }[] })
                    .account_tags.map(at => at.account_guid),
            } : {}),
        }));

        return NextResponse.json(result);
    } catch (error) {
        console.error('Error fetching tags:', error);
        return NextResponse.json({ error: 'Failed to fetch tags' }, { status: 500 });
    }
}

/**
 * POST /api/tags
 * Creates a tag in the active book. Body: { name: string, color?: string, description?: string }.
 * Color is auto-assigned from the palette when omitted. Names are unique per book.
 */
export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json();
        const name = normalizeTagName(String(body.name ?? ''));

        if (!isValidTagName(name)) {
            return NextResponse.json(
                { error: 'Invalid tag name. Use lowercase letters, digits, hyphens, and underscores (max 100 chars).' },
                { status: 400 }
            );
        }

        if (body.color != null && !TAG_COLORS.includes(body.color)) {
            return NextResponse.json(
                { error: `Invalid color. Must be one of: ${TAG_COLORS.join(', ')}` },
                { status: 400 }
            );
        }

        const bookGuid = await getActiveBookGuid();

        const existing = await prisma.gnucash_web_tags.findFirst({
            where: { book_guid: bookGuid, name },
        });
        if (existing) {
            return NextResponse.json({ error: `Tag "${name}" already exists` }, { status: 409 });
        }

        let color: string | null = body.color ?? null;
        if (!color) {
            const used = await prisma.gnucash_web_tags.findMany({
                where: { book_guid: bookGuid },
                select: { color: true },
            });
            color = pickTagColor(used.map(t => t.color));
        }

        const tag = await prisma.gnucash_web_tags.create({
            data: {
                book_guid: bookGuid,
                name,
                color,
                description: body.description ? String(body.description) : null,
            },
        });

        return NextResponse.json(
            { ...tag, transaction_count: 0, account_count: 0 },
            { status: 201 }
        );
    } catch (error) {
        console.error('Error creating tag:', error);
        return NextResponse.json({ error: 'Failed to create tag' }, { status: 500 });
    }
}
