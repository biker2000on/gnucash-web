import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids, getActiveBookRootGuid } from '@/lib/book-scope';
import prisma from '@/lib/prisma';
import {
    SCHEDULE_E_EXPENSE_LINE_ORDER,
    SCHEDULE_E_LINE_LABELS,
    mapRentalAccountToLine,
    getProperties,
    saveProperties,
    ScheduleEValidationError,
} from '@/lib/reports/schedule-e';

interface AccountRow {
    guid: string;
    name: string;
    fullname: string;
    account_type: string;
}

/**
 * GET /api/business/schedule-e/properties
 * The book's rental property definitions plus every INCOME/EXPENSE account
 * (with its keyword-heuristic line for expense accounts) for the subtree
 * pickers, and the selectable Schedule E line options.
 */
export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const [bookAccountGuids, bookRootGuid] = await Promise.all([
            getBookAccountGuids(),
            getActiveBookRootGuid(),
        ]);

        const [properties, accountRows] = await Promise.all([
            getProperties(bookRootGuid),
            prisma.$queryRaw<AccountRow[]>`
                SELECT guid, name, fullname, account_type
                FROM account_hierarchy
                WHERE guid = ANY(${bookAccountGuids}::text[])
                  AND account_type IN ('INCOME', 'EXPENSE')
                ORDER BY fullname
            `,
        ]);

        const accounts = accountRows.map((a) => ({
            guid: a.guid,
            name: a.name,
            fullname: a.fullname,
            accountType: a.account_type,
            keywordLine:
                a.account_type === 'EXPENSE'
                    ? mapRentalAccountToLine(a.name, a.fullname)
                    : '3',
        }));

        const lineOptions = SCHEDULE_E_EXPENSE_LINE_ORDER.map((line) => ({
            line,
            label: SCHEDULE_E_LINE_LABELS[line],
        }));

        return NextResponse.json({ properties, accounts, lineOptions });
    } catch (error) {
        console.error('Error fetching Schedule E properties:', error);
        return NextResponse.json(
            { error: 'Failed to fetch Schedule E properties' },
            { status: 500 },
        );
    }
}

/**
 * PUT /api/business/schedule-e/properties
 * Body: { properties: ScheduleEProperty[] } — full-set replace: properties
 * absent from the body are deleted, the rest are upserted. Returns the
 * normalized saved definitions.
 */
export async function PUT(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json();
        const properties: unknown = body?.properties;
        if (!Array.isArray(properties)) {
            return NextResponse.json(
                { error: 'Body must include a "properties" array' },
                { status: 400 },
            );
        }

        const [bookAccountGuids, bookRootGuid] = await Promise.all([
            getBookAccountGuids(),
            getActiveBookRootGuid(),
        ]);

        try {
            const saved = await saveProperties(properties, bookRootGuid, bookAccountGuids);
            return NextResponse.json({ properties: saved });
        } catch (err) {
            if (err instanceof ScheduleEValidationError) {
                return NextResponse.json({ error: err.message }, { status: 400 });
            }
            throw err;
        }
    } catch (error) {
        console.error('Error saving Schedule E properties:', error);
        return NextResponse.json(
            { error: 'Failed to save Schedule E properties' },
            { status: 500 },
        );
    }
}
