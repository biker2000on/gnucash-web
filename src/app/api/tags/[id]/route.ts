import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { normalizeTagName, isValidTagName, TAG_COLORS } from '@/lib/tags';

/**
 * PATCH /api/tags/{id}
 * Rename/recolor/redescribe a tag. Body: { name?, color?, description? }.
 */
export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { id: idParam } = await params;
        const id = parseInt(idParam, 10);
        if (!Number.isInteger(id)) {
            return NextResponse.json({ error: 'Invalid tag id' }, { status: 400 });
        }

        const tag = await prisma.gnucash_web_tags.findUnique({ where: { id } });
        if (!tag) {
            return NextResponse.json({ error: 'Tag not found' }, { status: 404 });
        }

        const body = await request.json();
        const data: { name?: string; color?: string | null; description?: string | null } = {};

        if ('name' in body) {
            const name = normalizeTagName(String(body.name ?? ''));
            if (!isValidTagName(name)) {
                return NextResponse.json(
                    { error: 'Invalid tag name. Use lowercase letters, digits, hyphens, and underscores (max 100 chars).' },
                    { status: 400 }
                );
            }
            if (name !== tag.name) {
                const existing = await prisma.gnucash_web_tags.findUnique({ where: { name } });
                if (existing) {
                    return NextResponse.json({ error: `Tag "${name}" already exists` }, { status: 409 });
                }
            }
            data.name = name;
        }

        if ('color' in body) {
            if (body.color != null && !TAG_COLORS.includes(body.color)) {
                return NextResponse.json(
                    { error: `Invalid color. Must be one of: ${TAG_COLORS.join(', ')}` },
                    { status: 400 }
                );
            }
            data.color = body.color ?? null;
        }

        if ('description' in body) {
            data.description = body.description ? String(body.description) : null;
        }

        if (Object.keys(data).length === 0) {
            return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
        }

        const updated = await prisma.gnucash_web_tags.update({
            where: { id },
            data,
            include: { _count: { select: { transaction_tags: true, account_tags: true } } },
        });

        return NextResponse.json({
            id: updated.id,
            name: updated.name,
            color: updated.color,
            description: updated.description,
            created_at: updated.created_at,
            transaction_count: updated._count.transaction_tags,
            account_count: updated._count.account_tags,
        });
    } catch (error) {
        console.error('Error updating tag:', error);
        return NextResponse.json({ error: 'Failed to update tag' }, { status: 500 });
    }
}

/**
 * DELETE /api/tags/{id}
 * Deletes a tag; junction rows cascade.
 */
export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { id: idParam } = await params;
        const id = parseInt(idParam, 10);
        if (!Number.isInteger(id)) {
            return NextResponse.json({ error: 'Invalid tag id' }, { status: 400 });
        }

        const tag = await prisma.gnucash_web_tags.findUnique({ where: { id } });
        if (!tag) {
            return NextResponse.json({ error: 'Tag not found' }, { status: 404 });
        }

        await prisma.gnucash_web_tags.delete({ where: { id } });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error deleting tag:', error);
        return NextResponse.json({ error: 'Failed to delete tag' }, { status: 500 });
    }
}
