import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { generateAverageBalance } from '@/lib/reports/average-balance';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GUID_RE = /^[0-9a-f]{32}$/i;

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);

        const now = new Date();
        const startDate = searchParams.get('startDate') || `${now.getFullYear()}-01-01`;
        const endDate = searchParams.get('endDate') || now.toISOString().split('T')[0];
        if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
            return NextResponse.json({ error: 'Dates must be in YYYY-MM-DD format' }, { status: 400 });
        }

        // Optional comma-separated account GUIDs; invalid entries are rejected,
        // out-of-book entries are ignored by the generator.
        const accountsParam = searchParams.get('accounts');
        let accountGuids: string[] | null = null;
        if (accountsParam) {
            accountGuids = accountsParam.split(',').map(s => s.trim()).filter(Boolean);
            if (accountGuids.some(guid => !GUID_RE.test(guid))) {
                return NextResponse.json({ error: 'Invalid account GUID' }, { status: 400 });
            }
        }

        const bookAccountGuids = await getBookAccountGuids();

        const report = await generateAverageBalance({
            startDate,
            endDate,
            accountGuids,
            bookAccountGuids,
        });
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating average balance report:', error);
        return NextResponse.json(
            { error: 'Failed to generate average balance report' },
            { status: 500 }
        );
    }
}
