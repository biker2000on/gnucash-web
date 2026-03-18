import { NextResponse } from 'next/server';
import { isAccountInActiveBook } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';
import { getAccountLots, getFreeSplits } from '@/lib/lots';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid: accountGuid } = await params;

        // Verify account belongs to active book
        if (!await isAccountInActiveBook(accountGuid)) {
            return NextResponse.json({ error: 'Account not found' }, { status: 404 });
        }

        const { searchParams } = new URL(request.url);
        const includeFreeSplits = searchParams.get('includeFreeSplits') === 'true';

        const lots = await getAccountLots(accountGuid);

        const response: { lots: typeof lots; freeSplits?: Awaited<ReturnType<typeof getFreeSplits>> } = { lots };

        if (includeFreeSplits) {
            response.freeSplits = await getFreeSplits(accountGuid);
        }

        return NextResponse.json(response);
    } catch (error) {
        console.error('Error fetching account lots:', error);
        return NextResponse.json({ error: 'Failed to fetch lots' }, { status: 500 });
    }
}
