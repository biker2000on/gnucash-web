import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import prisma from '@/lib/prisma';
import {
    SCHEDULE_F_EXPENSE_LINE_ORDER,
    SCHEDULE_F_LINE_LABELS,
    mapFarmExpenseAccountToLine,
} from '@/lib/business/schedule-f';
import {
    getMappings,
    saveMappings,
    ScheduleFMappingValidationError,
    type MappingChange,
} from '@/lib/business/schedule-f-mappings';

interface ExpenseAccountRow {
    guid: string;
    name: string;
    fullname: string;
    account_type: string;
}

/**
 * GET /api/business/schedule-f/mappings
 * Manual Schedule F overrides plus every EXPENSE account in the active book
 * (with its keyword-heuristic line) and the selectable line options.
 */
export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const bookAccountGuids = await getBookAccountGuids();

        const [mappings, accountRows] = await Promise.all([
            getMappings(bookAccountGuids),
            prisma.$queryRaw<ExpenseAccountRow[]>`
                SELECT guid, name, fullname, account_type
                FROM account_hierarchy
                WHERE guid = ANY(${bookAccountGuids}::text[])
                  AND account_type = 'EXPENSE'
                ORDER BY fullname
            `,
        ]);

        const accounts = accountRows.map((a) => ({
            guid: a.guid,
            name: a.name,
            fullname: a.fullname,
            accountType: a.account_type,
            keywordLine: mapFarmExpenseAccountToLine(a.name, a.fullname),
        }));

        const lineOptions = SCHEDULE_F_EXPENSE_LINE_ORDER.map((line) => ({
            line,
            label: SCHEDULE_F_LINE_LABELS[line],
        }));

        return NextResponse.json({ mappings, accounts, lineOptions });
    } catch (error) {
        console.error('Error fetching Schedule F mappings:', error);
        return NextResponse.json(
            { error: 'Failed to fetch Schedule F mappings' },
            { status: 500 },
        );
    }
}

/**
 * PUT /api/business/schedule-f/mappings
 * Body: { changes: Array<{ accountGuid: string, line: string | null }> }
 * line null removes the override. Returns the updated mappings.
 */
export async function PUT(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json();
        const changes: unknown = body?.changes;
        if (!Array.isArray(changes)) {
            return NextResponse.json(
                { error: 'Body must include a "changes" array' },
                { status: 400 },
            );
        }
        if (changes.length > 500) {
            return NextResponse.json(
                { error: 'Too many changes in one request (max 500)' },
                { status: 400 },
            );
        }

        const bookAccountGuids = await getBookAccountGuids();

        try {
            await saveMappings(changes as MappingChange[], bookAccountGuids);
        } catch (err) {
            if (err instanceof ScheduleFMappingValidationError) {
                return NextResponse.json({ error: err.message }, { status: 400 });
            }
            throw err;
        }

        const mappings = await getMappings(bookAccountGuids);
        return NextResponse.json({ mappings });
    } catch (error) {
        console.error('Error saving Schedule F mappings:', error);
        return NextResponse.json(
            { error: 'Failed to save Schedule F mappings' },
            { status: 500 },
        );
    }
}
