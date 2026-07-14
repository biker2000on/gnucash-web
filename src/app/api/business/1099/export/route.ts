import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getEntityProfile } from '@/lib/services/entity.service';
import { escapeCSVField } from '@/lib/reports/csv-export';
import {
    get1099Summary,
    parseYearParam,
    NEC_THRESHOLD,
} from '@/lib/business/vendor-1099.service';

/**
 * 1099-NEC prep worksheet (CSV) — one row per vendor at/over the $600
 * threshold, with payer info from the entity profile. Explicitly labeled as
 * a preparation worksheet, NOT an official IRS form.
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { user, bookGuid } = roleResult;

        const { searchParams } = new URL(request.url);
        const year = parseYearParam(searchParams.get('year'));
        if (year === null) {
            return NextResponse.json({ error: 'Invalid year' }, { status: 400 });
        }

        const bookAccountGuids = await getBookAccountGuids();
        const [summary, profile] = await Promise.all([
            get1099Summary(bookGuid, bookAccountGuids, year),
            getEntityProfile(bookGuid, user.id),
        ]);

        const payerName = profile.entityName ?? '';
        const payerState = profile.taxState ?? '';

        const lines: string[] = [
            `1099-NEC PREP WORKSHEET — TAX YEAR ${year} — NOT AN OFFICIAL IRS FORM`,
            `Vendors paid at least $${NEC_THRESHOLD} in ${year}. Verify amounts and full TINs against your records before filing (only masked TINs are stored here).`,
            '',
            [
                'Payer Name',
                'Payer State',
                'Recipient Legal Name',
                'Recipient TIN (masked - obtain full TIN from W-9)',
                'Recipient Address',
                'Box 1 Nonemployee Compensation',
                'W-9 Received',
                'Status',
            ].map(escapeCSVField).join(','),
        ];

        for (const vendor of summary.vendors) {
            if (!vendor.crosses600) continue;
            const info = vendor.taxInfo;
            lines.push(
                [
                    payerName,
                    payerState,
                    info?.legalName || vendor.name,
                    info?.taxIdMasked ?? '',
                    (info?.address ?? '').replace(/\r?\n/g, ', '),
                    vendor.totalPaid.toFixed(2),
                    info?.w9Received ? 'yes' : 'no',
                    vendor.status,
                ].map(escapeCSVField).join(',')
            );
        }

        return new Response(lines.join('\n') + '\n', {
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="1099-nec-worksheet-${year}.csv"`,
                'Cache-Control': 'no-store',
            },
        });
    } catch (error) {
        console.error('Error exporting 1099 worksheet:', error);
        return NextResponse.json({ error: 'Failed to export 1099 worksheet' }, { status: 500 });
    }
}
