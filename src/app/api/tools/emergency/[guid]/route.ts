import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { isAccountInActiveBook } from '@/lib/book-scope';
import { upsertAccountEmergencyInfo } from '@/lib/emergency-info';

const GUID_RE = /^[0-9a-f]{32}$/i;

/**
 * PUT /api/tools/emergency/[guid]
 *
 * Upsert per-account emergency metadata for one account in the active book.
 * Body: { institution?, beneficiary?, contact?, loginHint?, notes? }
 * Sending all-empty fields clears the stored row.
 */
export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> },
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        if (!GUID_RE.test(guid)) {
            return NextResponse.json({ error: 'Invalid account guid' }, { status: 400 });
        }
        if (!(await isAccountInActiveBook(guid))) {
            return NextResponse.json({ error: 'Account not found in active book' }, { status: 404 });
        }

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }

        const info = await upsertAccountEmergencyInfo(guid, {
            institution: body.institution,
            beneficiary: body.beneficiary,
            contact: body.contact,
            loginHint: body.loginHint,
            notes: body.notes,
        });
        return NextResponse.json({ info });
    } catch (error) {
        console.error('Emergency account info API error:', error);
        return NextResponse.json(
            { error: 'Failed to save emergency info' },
            { status: 500 },
        );
    }
}
