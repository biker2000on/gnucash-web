import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import {
    generateAccountBreakdown,
    BreakdownAccountType,
} from '@/lib/reports/account-breakdown';

const VALID_TYPES: BreakdownAccountType[] = ['ASSET', 'LIABILITY', 'INCOME', 'EXPENSE'];
const GUID_RE = /^[0-9a-f]{32}$/i;

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);

        const typeParam = (searchParams.get('type') || 'EXPENSE').toUpperCase();
        if (!VALID_TYPES.includes(typeParam as BreakdownAccountType)) {
            return NextResponse.json(
                { error: `Invalid type. Expected one of: ${VALID_TYPES.join(', ')}` },
                { status: 400 }
            );
        }
        const type = typeParam as BreakdownAccountType;

        const depthParam = parseInt(searchParams.get('depth') || '2', 10);
        if (Number.isNaN(depthParam) || depthParam < 1 || depthParam > 4) {
            return NextResponse.json({ error: 'depth must be between 1 and 4' }, { status: 400 });
        }

        const maxSlicesParam = parseInt(searchParams.get('maxSlices') || '10', 10);
        const maxSlices = Number.isNaN(maxSlicesParam)
            ? 10
            : Math.min(Math.max(maxSlicesParam, 3), 30);

        const rootGuid = searchParams.get('rootGuid');
        if (rootGuid && !GUID_RE.test(rootGuid)) {
            return NextResponse.json({ error: 'Invalid rootGuid' }, { status: 400 });
        }

        const bookAccountGuids = await getBookAccountGuids();
        if (rootGuid && !bookAccountGuids.includes(rootGuid)) {
            return NextResponse.json({ error: 'Account not found' }, { status: 404 });
        }

        const now = new Date();
        const endDate = searchParams.get('endDate') || now.toISOString().split('T')[0];
        const startDate = searchParams.get('startDate') || `${now.getFullYear()}-01-01`;

        const report = await generateAccountBreakdown({
            type,
            depth: depthParam,
            startDate,
            endDate,
            maxSlices,
            rootGuid,
            bookAccountGuids,
        });

        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating account breakdown report:', error);
        return NextResponse.json(
            { error: 'Failed to generate account breakdown report' },
            { status: 500 }
        );
    }
}
