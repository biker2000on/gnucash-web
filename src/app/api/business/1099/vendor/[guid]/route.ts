import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    upsertVendorTaxInfo,
    Vendor1099NotFoundError,
    Vendor1099ValidationError,
    type UpsertVendorTaxInfoInput,
} from '@/lib/business/vendor-1099.service';

type RouteParams = { params: Promise<{ guid: string }> };

const optionalString = (v: unknown): string | null | undefined =>
    v === undefined ? undefined : v === null ? null : String(v);

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
        // One-release compatibility for browser bundles deployed before the
        // override rename. Prefer the new key even when it is explicitly null.
        const exemptValue = body.exemptFrom1099Override === undefined
            ? body.exemptFrom1099
            : body.exemptFrom1099Override;

        const input: UpsertVendorTaxInfoInput = {
            legalName: optionalString(body.legalName),
            taxClassification: optionalString(body.taxClassification),
            tinLast4: optionalString(body.tinLast4),
            w9Received: body.w9Received === undefined ? undefined : Boolean(body.w9Received),
            w9ReceivedDate: optionalString(body.w9ReceivedDate),
            w9RequestedDate: optionalString(body.w9RequestedDate),
            exemptFrom1099Override:
                exemptValue === undefined
                    ? undefined
                    : exemptValue === null
                        ? null
                        : Boolean(exemptValue),
            attorneyOrMedicalPayments:
                body.attorneyOrMedicalPayments === undefined
                    ? undefined
                    : Boolean(body.attorneyOrMedicalPayments),
            address: optionalString(body.address),
            notes: optionalString(body.notes),
        };

        const taxInfo = await upsertVendorTaxInfo(bookGuid, guid, input);
        return NextResponse.json({ vendorGuid: guid, taxInfo });
    } catch (error) {
        if (error instanceof Vendor1099ValidationError) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        if (error instanceof Vendor1099NotFoundError) {
            return NextResponse.json({ error: error.message }, { status: 404 });
        }
        console.error('Error saving vendor tax info:', error);
        return NextResponse.json({ error: 'Failed to save vendor tax info' }, { status: 500 });
    }
}
