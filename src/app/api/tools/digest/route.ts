import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookRootGuid } from '@/lib/book-scope';
import { generateDigest, normalizeMonth, digestToSummaryText } from '@/lib/digest';
import { createNotification, ensureNotificationsTable } from '@/lib/notifications';
import prisma from '@/lib/prisma';

/**
 * GET /api/tools/digest
 *
 * Returns the assembled monthly financial digest for the active book.
 *
 * Query params:
 *   month  Target month as YYYY-MM (default: current calendar month, UTC)
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const { searchParams } = new URL(request.url);
        let month: string;
        try {
            month = normalizeMonth(searchParams.get('month') ?? undefined);
        } catch {
            return NextResponse.json(
                { error: 'Invalid month (expected YYYY-MM)' },
                { status: 400 }
            );
        }

        const rootGuid = await getActiveBookRootGuid();
        const digest = await generateDigest(rootGuid, { month });

        return NextResponse.json({ ...digest, bookGuid });
    } catch (error) {
        console.error('Error generating monthly digest:', error);
        return NextResponse.json(
            { error: 'Failed to generate monthly digest' },
            { status: 500 }
        );
    }
}

/**
 * POST /api/tools/digest
 *
 * Generates the digest for a month (default current) and delivers it to the
 * current user as a notification. Deduped per month via source='digest',
 * sourceId=<month> so the same month is not delivered twice.
 *
 * Body (optional): { "month": "YYYY-MM" }
 */
export async function POST(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { user, bookGuid } = roleResult;

        let month: string;
        try {
            const body = await request.json().catch(() => ({}));
            month = normalizeMonth(body?.month);
        } catch {
            return NextResponse.json(
                { error: 'Invalid month (expected YYYY-MM)' },
                { status: 400 }
            );
        }

        const rootGuid = await getActiveBookRootGuid();
        const digest = await generateDigest(rootGuid, { month });

        // Dedupe: skip if this month's digest was already delivered to the user.
        await ensureNotificationsTable();
        const existing = await prisma.$queryRaw<Array<{ id: number }>>`
            SELECT id
            FROM gnucash_web_notifications
            WHERE user_id = ${user.id}
              AND source = 'digest'
              AND source_id = ${digest.month}
            LIMIT 1
        `;

        if (existing.length > 0) {
            return NextResponse.json({
                delivered: false,
                deduped: true,
                month: digest.month,
                notificationId: existing[0].id,
            });
        }

        const notification = await createNotification({
            userId: user.id,
            bookGuid,
            type: 'monthly_digest',
            severity: 'info',
            title: `Monthly digest — ${digest.monthLabel}`,
            message: digestToSummaryText(digest),
            href: `/tools/digest?month=${digest.month}`,
            source: 'digest',
            sourceId: digest.month,
        });

        return NextResponse.json({
            delivered: true,
            deduped: false,
            month: digest.month,
            notificationId: notification.id,
        });
    } catch (error) {
        console.error('Error delivering monthly digest:', error);
        return NextResponse.json(
            { error: 'Failed to deliver monthly digest' },
            { status: 500 }
        );
    }
}
