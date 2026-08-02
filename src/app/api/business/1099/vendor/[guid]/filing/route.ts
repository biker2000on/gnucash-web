import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    setVendor1099Filing,
    Vendor1099NotFoundError,
    Vendor1099ValidationError,
} from '@/lib/business/vendor-1099.service';

type RouteParams = { params: Promise<{ guid: string }> };

/**
 * Record or clear the date a 1099-NEC was filed for one vendor and tax year.
 * Body: { taxYear: number, filedDate: 'YYYY-MM-DD' | null }.
 */
export async function PUT(request: Request, { params }: RouteParams) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const { guid } = await params;
        if (!/^[0-9a-f]{32}$/i.test(guid)) {
            return NextResponse.json({ error: 'Invalid vendor guid' }, { status: 400 });
        }

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }

        const taxYear = Number(body.taxYear);
        if (!Number.isInteger(taxYear)) {
            return NextResponse.json({ error: 'taxYear must be an integer' }, { status: 400 });
        }
        const filedDate =
            body.filedDate === undefined || body.filedDate === null ? null : String(body.filedDate);

        const result = await setVendor1099Filing(bookGuid, guid, taxYear, filedDate);
        return NextResponse.json(result);
    } catch (error) {
        if (error instanceof Vendor1099ValidationError) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        if (error instanceof Vendor1099NotFoundError) {
            return NextResponse.json({ error: error.message }, { status: 404 });
        }
        console.error('Error saving 1099 filing status:', error);
        return NextResponse.json({ error: 'Failed to save 1099 filing status' }, { status: 500 });
    }
}
