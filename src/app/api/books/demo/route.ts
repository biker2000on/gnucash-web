import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireAuth, requireRole } from '@/lib/auth';
import { createDemoBook, DEMO_BOOK_KINDS } from '@/lib/services/demo-book.service';
import type { DemoBookKind } from '@/lib/demo-seed';

/**
 * POST /api/books/demo
 * Create a demo book ('household' | 'business') seeded with ~12 months of
 * deterministic sample data, and grant the caller admin on it.
 *
 * Body: { kind: 'household' | 'business' }
 *
 * Requires the edit role. On a fresh install with no books at all (first-run
 * onboarding), requireRole cannot resolve an active book, so plain
 * authentication suffices — the caller is bootstrapping their first book.
 */
export async function POST(request: NextRequest) {
    try {
        const hasBooks = (await prisma.books.count()) > 0;
        let userId: number;
        if (hasBooks) {
            const roleResult = await requireRole('edit');
            if (roleResult instanceof NextResponse) return roleResult;
            userId = roleResult.user.id;
        } else {
            const authResult = await requireAuth();
            if (authResult instanceof NextResponse) return authResult;
            userId = authResult.user.id;
        }

        const body = await request.json().catch(() => ({}));
        const kind = body?.kind as DemoBookKind;
        if (!DEMO_BOOK_KINDS.includes(kind)) {
            return NextResponse.json(
                { error: "kind must be 'household' or 'business'" },
                { status: 400 }
            );
        }

        const result = await createDemoBook(userId, kind);
        return NextResponse.json({ success: true, ...result }, { status: 201 });
    } catch (error) {
        console.error('Error creating demo book:', error);
        const message = error instanceof Error ? error.message : 'Failed to create demo book';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
