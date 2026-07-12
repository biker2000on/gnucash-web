import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { cacheInvalidateFrom } from '@/lib/cache';
import {
    getRule,
    planHistoricalApplication,
    applyHistoricalMatches,
    HISTORY_APPLY_CAP,
} from '@/lib/services/categorization.service';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @openapi
 * /api/settings/rules/apply-history:
 *   post:
 *     description: >
 *       Retroactively apply a categorization rule to historical transactions
 *       in the active book. Body:
 *       { ruleId: number, dryRun?: boolean (default true), startDate?: 'YYYY-MM-DD',
 *         endDate?: 'YYYY-MM-DD', onlyUncategorized?: boolean (default true) }.
 *       Matching uses the same semantics as import-time (contains/exact/regex,
 *       case-insensitive). Only transactions whose counter-split is on an
 *       Imbalance/Orphan account qualify unless onlyUncategorized is false
 *       (then any EXPENSE/INCOME counter-split qualifies). Ambiguous
 *       transactions (more than one candidate counter-split) are reported as
 *       skipped. Capped at 500 changes per call with a moreRemain flag.
 *       Dry runs return the would-change list without writing; non-dry runs
 *       apply the recategorization in a single database transaction.
 */
export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json();

        const ruleId = Number(body.ruleId);
        if (!Number.isInteger(ruleId) || ruleId <= 0) {
            return NextResponse.json({ error: 'ruleId must be a positive integer' }, { status: 400 });
        }
        // Safe default: omitting dryRun previews rather than writes.
        const dryRun = body.dryRun === undefined ? true : Boolean(body.dryRun);
        const onlyUncategorized = body.onlyUncategorized === undefined ? true : Boolean(body.onlyUncategorized);

        for (const key of ['startDate', 'endDate'] as const) {
            const value = body[key];
            if (value !== undefined && (typeof value !== 'string' || !DATE_RE.test(value))) {
                return NextResponse.json({ error: `${key} must be YYYY-MM-DD` }, { status: 400 });
            }
        }
        const startDate: string | undefined = body.startDate || undefined;
        const endDate: string | undefined = body.endDate || undefined;

        const rule = await getRule(roleResult.bookGuid, ruleId);
        if (!rule) {
            return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
        }

        const bookAccountGuids = await getBookAccountGuids();
        if (!bookAccountGuids.includes(rule.accountGuid)) {
            return NextResponse.json(
                { error: 'Rule target account does not belong to the active book' },
                { status: 400 }
            );
        }

        let plan;
        try {
            plan = await planHistoricalApplication(rule, bookAccountGuids, {
                startDate,
                endDate,
                onlyUncategorized,
                limit: HISTORY_APPLY_CAP,
            });
        } catch (err) {
            return NextResponse.json(
                { error: err instanceof Error ? err.message : 'Failed to plan rule application' },
                { status: 400 }
            );
        }

        if (dryRun) {
            return NextResponse.json({
                dryRun: true,
                matchCount: plan.matches.length,
                skippedCount: plan.skipped.length,
                moreRemain: plan.moreRemain,
                matches: plan.matches,
                skipped: plan.skipped,
            });
        }

        const applied = await applyHistoricalMatches(plan.matches);

        // Recategorizing changes account-scoped metrics; invalidate caches
        // from the earliest affected date (best-effort).
        if (applied > 0) {
            try {
                const dates = plan.matches
                    .map(m => m.date)
                    .filter(Boolean)
                    .sort();
                if (dates.length > 0) {
                    await cacheInvalidateFrom(roleResult.bookGuid, new Date(`${dates[0]}T00:00:00.000Z`));
                }
            } catch (err) {
                console.warn('Cache invalidation failed:', err);
            }
        }

        return NextResponse.json({
            dryRun: false,
            applied,
            matchCount: plan.matches.length,
            skippedCount: plan.skipped.length,
            skipped: plan.skipped,
            moreRemain: plan.moreRemain,
        });
    } catch (error) {
        console.error('Failed to apply rule to history:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
