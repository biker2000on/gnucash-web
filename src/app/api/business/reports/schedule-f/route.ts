import { NextRequest, NextResponse } from 'next/server';
import { generateScheduleF } from '@/lib/business/schedule-f-report';
import { getMappings } from '@/lib/business/schedule-f-mappings';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getEntityProfile } from '@/lib/services/entity.service';
import { FARM_CAPABLE_ENTITY_TYPES } from '@/lib/book-templates';
import {
  expandGuidsToDescendants,
  loadPinnedFarmRoots,
} from '@/lib/tax/farm-book-data';
import { requireRole } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { FarmCurrencyConversionError } from '@/lib/tax/farm-currency';

/**
 * GET /api/business/reports/schedule-f?year=YYYY
 *
 * Account universe:
 * - business book: every INCOME/EXPENSE account in the book;
 * - household book: the farm subtrees pinned in the Farm & Apiary Analyzer
 *   (expanded to descendants) so the report works before a farm book exists.
 *   Returns { needsFarmAccounts: true } when nothing is pinned.
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { user, bookGuid } = roleResult;

        const { searchParams } = new URL(request.url);
        const yearParam = searchParams.get('year');
        const year = yearParam ? parseInt(yearParam, 10) : new Date().getUTCFullYear();
        if (!Number.isInteger(year) || year < 1900 || year > 2200) {
            return NextResponse.json({ error: 'Invalid year' }, { status: 400 });
        }

        const bookAccountGuids = await getBookAccountGuids();
        const entity = await getEntityProfile(bookGuid, user.id);

        let restrictToGuids: string[] | undefined;
        // Whole-book mode only when the book is a farm-labeled pass-through
        // business — a general (Schedule C) business book must NOT have its
        // entire ledger treated as farm activity.
        const scopedToFarmSelection = !(
            FARM_CAPABLE_ENTITY_TYPES.has(entity.entityType) &&
            entity.businessActivity === 'farm'
        );
        if (scopedToFarmSelection) {
            // Household (or non-farm business) book: scope to the analyzer's
            // pinned farm subtrees.
            const pinnedRoots = await loadPinnedFarmRoots(user.id, bookGuid);
            const roots = [...pinnedRoots.incomeRootGuids, ...pinnedRoots.expenseRootGuids];
            if (roots.length === 0) {
                return NextResponse.json({
                    needsFarmAccounts: true,
                    entityType: entity.entityType,
                });
            }
            const accountRows = await prisma.$queryRaw<
                Array<{ guid: string; parent_guid: string | null }>
            >`
                SELECT guid, parent_guid FROM account_hierarchy
                WHERE guid = ANY(${bookAccountGuids}::text[])
            `;
            restrictToGuids = expandGuidsToDescendants(roots, accountRows);
        }

        const overrides = await getMappings(bookAccountGuids);
        const report = await generateScheduleF(bookGuid, bookAccountGuids, year, overrides, restrictToGuids);
        return NextResponse.json({
            ...report,
            scopedToFarmSelection,
            businessActivity: entity.businessActivity,
        });
    } catch (error) {
        if (error instanceof FarmCurrencyConversionError) {
            return NextResponse.json(
                { error: error.message, missingRates: error.missingRates },
                { status: 422 },
            );
        }
        console.error('Error generating Schedule F report:', error);
        return NextResponse.json(
            { error: 'Failed to generate Schedule F report' },
            { status: 500 }
        );
    }
}
