import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { isAccountInActiveBook } from '@/lib/book-scope';
import {
    upsertFixedIncomeMetadata,
    deleteFixedIncomeMetadata,
    FixedIncomeValidationError,
} from '@/lib/fixed-income';

const GUID_RE = /^[0-9a-f]{32}$/i;

/**
 * PUT /api/investments/fixed-income/[guid]
 *
 * Create/update fixed-income metadata for an account in the active book.
 * Body: { kind, faceValue, couponRate?, purchaseDate?, maturityDate, callable? }
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

        const metadata = await upsertFixedIncomeMetadata(guid, {
            kind: body.kind,
            faceValue: body.faceValue,
            couponRate: body.couponRate,
            purchaseDate: body.purchaseDate ?? null,
            maturityDate: body.maturityDate,
            callable: body.callable,
        });
        return NextResponse.json({ metadata });
    } catch (error) {
        if (error instanceof FixedIncomeValidationError) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        console.error('Fixed income metadata API error:', error);
        return NextResponse.json(
            { error: 'Failed to save fixed income metadata' },
            { status: 500 },
        );
    }
}

/**
 * DELETE /api/investments/fixed-income/[guid]
 *
 * Remove fixed-income tracking from an account (the account itself is untouched).
 */
export async function DELETE(
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

        await deleteFixedIncomeMetadata(guid);
        return NextResponse.json({ ok: true });
    } catch (error) {
        console.error('Fixed income delete API error:', error);
        return NextResponse.json(
            { error: 'Failed to remove fixed income metadata' },
            { status: 500 },
        );
    }
}
