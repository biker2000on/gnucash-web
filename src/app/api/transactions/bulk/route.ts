import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid, getBookAccountGuids } from '@/lib/book-scope';
import { cacheInvalidateFrom } from '@/lib/cache';
import { publishDataChange } from '@/lib/data-events';
import {
    withPeriodLockCheck,
    assertNotLocked,
    PeriodLockedError,
    periodLockedResponse,
} from '@/lib/services/period-lock.service';
import {
    assertSplitsNotProtected,
    ReconciledSplitError,
    reconciledSplitResponse,
    type SplitReconcileRow,
} from '@/lib/services/reconciled-split.service';
import {
    selectRecategorizeSplit,
    replaceDescription,
    type RecategorizeSplitInfo,
} from '@/lib/bulk-edit';

const MAX_BULK = 500;

interface BulkResult {
    guid: string;
    ok: boolean;
    error?: string;
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(v => typeof v === 'string');
}

function isIntArray(value: unknown): value is number[] {
    return Array.isArray(value) && value.every(v => typeof v === 'number' && Number.isInteger(v));
}

/**
 * @openapi
 * /api/transactions/bulk:
 *   patch:
 *     description: >
 *       Bulk-edit transactions. Body:
 *       { transactionGuids: string[], anchorAccountGuid?: string,
 *         set: { description?: string,
 *                descriptionReplace?: { find: string, replace: string },
 *                recategorize?: { fromAccountGuid?: string, toAccountGuid: string },
 *                addTagIds?: number[], removeTagIds?: number[] } }.
 *       Recategorize moves each transaction's single counter-split (the split
 *       NOT on the anchor account) to toAccountGuid; when fromAccountGuid is
 *       given only splits currently on it are moved. Transactions whose
 *       counter-split is ambiguous are skipped and reported per-transaction.
 *       Returns { results: { guid, ok, error? }[], updated, skipped }.
 */
export async function PATCH(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json();

        if (!isStringArray(body.transactionGuids) || body.transactionGuids.length === 0) {
            return NextResponse.json(
                { error: 'transactionGuids must be a non-empty array of strings' },
                { status: 400 }
            );
        }
        if (body.transactionGuids.length > MAX_BULK) {
            return NextResponse.json(
                { error: `At most ${MAX_BULK} transactions per call` },
                { status: 400 }
            );
        }
        const transactionGuids: string[] = Array.from(new Set(body.transactionGuids));

        const set = body.set;
        if (!set || typeof set !== 'object') {
            return NextResponse.json({ error: 'set object is required' }, { status: 400 });
        }
        const { description, descriptionReplace, recategorize, addTagIds, removeTagIds } = set as {
            description?: unknown;
            descriptionReplace?: unknown;
            recategorize?: unknown;
            addTagIds?: unknown;
            removeTagIds?: unknown;
        };

        // --- validate description ops ---
        if (description !== undefined && typeof description !== 'string') {
            return NextResponse.json({ error: 'set.description must be a string' }, { status: 400 });
        }
        let replaceOp: { find: string; replace: string } | null = null;
        if (descriptionReplace !== undefined) {
            if (description !== undefined) {
                return NextResponse.json(
                    { error: 'set.description and set.descriptionReplace are mutually exclusive' },
                    { status: 400 }
                );
            }
            const dr = descriptionReplace as { find?: unknown; replace?: unknown };
            if (typeof dr?.find !== 'string' || dr.find.length === 0 || typeof dr?.replace !== 'string') {
                return NextResponse.json(
                    { error: 'set.descriptionReplace requires a non-empty find string and a replace string' },
                    { status: 400 }
                );
            }
            replaceOp = { find: dr.find, replace: dr.replace };
        }

        // --- validate tag ops ---
        if (addTagIds !== undefined && !isIntArray(addTagIds)) {
            return NextResponse.json({ error: 'set.addTagIds must be an array of integers' }, { status: 400 });
        }
        if (removeTagIds !== undefined && !isIntArray(removeTagIds)) {
            return NextResponse.json({ error: 'set.removeTagIds must be an array of integers' }, { status: 400 });
        }
        const addIds: number[] = Array.from(new Set((addTagIds as number[] | undefined) ?? []));
        const removeIds: number[] = Array.from(new Set((removeTagIds as number[] | undefined) ?? []));

        // --- validate recategorize op ---
        const bookGuidSet = new Set(await getBookAccountGuids());
        let recatOp: { toAccountGuid: string; fromAccountGuid?: string } | null = null;
        const anchorAccountGuid: string | undefined =
            typeof body.anchorAccountGuid === 'string' ? body.anchorAccountGuid : undefined;
        let targetCommodityGuid: string | null = null;
        if (recategorize !== undefined) {
            const rc = recategorize as { fromAccountGuid?: unknown; toAccountGuid?: unknown };
            if (typeof rc?.toAccountGuid !== 'string' || !rc.toAccountGuid) {
                return NextResponse.json(
                    { error: 'set.recategorize.toAccountGuid is required' },
                    { status: 400 }
                );
            }
            if (rc.fromAccountGuid !== undefined && typeof rc.fromAccountGuid !== 'string') {
                return NextResponse.json(
                    { error: 'set.recategorize.fromAccountGuid must be a string' },
                    { status: 400 }
                );
            }
            if (!rc.fromAccountGuid && !anchorAccountGuid) {
                return NextResponse.json(
                    { error: 'recategorize requires fromAccountGuid or a top-level anchorAccountGuid' },
                    { status: 400 }
                );
            }
            for (const [label, guid] of [
                ['toAccountGuid', rc.toAccountGuid],
                ['fromAccountGuid', rc.fromAccountGuid],
                ['anchorAccountGuid', anchorAccountGuid],
            ] as const) {
                if (guid && !bookGuidSet.has(guid)) {
                    return NextResponse.json(
                        { error: `${label} does not belong to the active book` },
                        { status: 400 }
                    );
                }
            }
            const targetAccount = await prisma.accounts.findUnique({
                where: { guid: rc.toAccountGuid },
                select: { guid: true, commodity_guid: true },
            });
            if (!targetAccount) {
                return NextResponse.json({ error: 'Target account not found' }, { status: 404 });
            }
            targetCommodityGuid = targetAccount.commodity_guid;
            recatOp = {
                toAccountGuid: rc.toAccountGuid,
                ...(rc.fromAccountGuid ? { fromAccountGuid: rc.fromAccountGuid } : {}),
            };
        }

        if (description === undefined && !replaceOp && !recatOp && addIds.length === 0 && removeIds.length === 0) {
            return NextResponse.json({ error: 'set must include at least one operation' }, { status: 400 });
        }

        // Tags being added must exist (FK) and belong to the active book;
        // removals of unknown ids are no-ops.
        if (addIds.length > 0) {
            const activeBookGuid = await getActiveBookGuid();
            const found = await prisma.gnucash_web_tags.findMany({
                where: { id: { in: addIds }, book_guid: activeBookGuid },
                select: { id: true },
            });
            if (found.length !== addIds.length) {
                const foundSet = new Set(found.map(t => t.id));
                const missing = addIds.filter(id => !foundSet.has(id));
                return NextResponse.json(
                    { error: `Unknown tag id(s): ${missing.join(', ')}` },
                    { status: 400 }
                );
            }
        }

        // Load the transactions with their splits + accounts up front.
        const txRows = await prisma.transactions.findMany({
            where: { guid: { in: transactionGuids } },
            select: {
                guid: true,
                post_date: true,
                description: true,
                splits: {
                    select: {
                        guid: true,
                        account_guid: true,
                        account: {
                            select: { guid: true, name: true, account_type: true, commodity_guid: true },
                        },
                    },
                },
            },
        });
        const txByGuid = new Map(txRows.map(t => [t.guid, t]));

        // Period lock pre-check: description edits and recategorizes alter
        // ledger content, so every targeted transaction must be after the
        // lock date. Tag-only operations are metadata and stay allowed.
        // (Fast-fail only — the authoritative check runs inside the DB
        // transaction below with the cache bypassed.)
        const hasCoreOps = description !== undefined || !!replaceOp || !!recatOp;
        if (hasCoreOps) {
            const lockError = await withPeriodLockCheck(
                roleResult.bookGuid,
                txRows.map(t => t.post_date),
            );
            if (lockError) return lockError;
        }

        const results: BulkResult[] = [];
        let updated = 0;
        let recategorized = false;
        const touchedDates: Date[] = [];
        const bulkEditTimestamp = new Date();

        // Live reconcile state of every split in the targeted transactions,
        // populated inside the DB transaction below when a recategorize is
        // requested.
        let liveSplitByGuid = new Map<string, SplitReconcileRow>();

        await prisma.$transaction(async dbTx => {
            // Period lock (authoritative, in-transaction, cache bypassed):
            // re-read the targeted transactions' post dates fresh so a
            // just-locked period cannot be edited through a stale snapshot.
            if (hasCoreOps) {
                const freshRows = await dbTx.transactions.findMany({
                    where: { guid: { in: transactionGuids } },
                    select: { post_date: true },
                });
                await assertNotLocked(
                    roleResult.bookGuid,
                    freshRows.map(t => t.post_date),
                    { bypassCache: true, client: dbTx },
                );
            }

            // Recategorizing re-books a split to another account. Reconciled
            // and frozen splits are agreed against a bank statement and must
            // not move, so read their live state inside the transaction and
            // refuse the whole batch if any selected counter-split is
            // protected. Read here (not from the pre-transaction snapshot) so
            // a concurrent reconcile cannot slip past the check.
            if (recatOp) {
                const liveSplits = await dbTx.splits.findMany({
                    where: { tx_guid: { in: transactionGuids } },
                    select: {
                        guid: true,
                        tx_guid: true,
                        account_guid: true,
                        reconcile_state: true,
                        account: { select: { name: true } },
                    },
                });
                liveSplitByGuid = new Map(liveSplits.map(s => [s.guid, s]));
            }

            for (const guid of transactionGuids) {
                const t = txByGuid.get(guid);
                if (!t) {
                    results.push({ guid, ok: false, error: 'transaction not found' });
                    continue;
                }
                if (!t.splits.some(s => bookGuidSet.has(s.account_guid))) {
                    results.push({ guid, ok: false, error: 'transaction not in active book' });
                    continue;
                }

                // Plan the recategorize before touching anything so a skipped
                // transaction stays fully unmodified.
                let moveSplit: RecategorizeSplitInfo | null = null;
                if (recatOp) {
                    const infos: RecategorizeSplitInfo[] = t.splits.map(s => ({
                        guid: s.guid,
                        accountGuid: s.account.guid,
                        accountName: s.account.name,
                        accountType: s.account.account_type,
                        commodityGuid: s.account.commodity_guid,
                    }));
                    const sel = selectRecategorizeSplit(infos, {
                        toAccountGuid: recatOp.toAccountGuid,
                        anchorAccountGuid,
                        fromAccountGuid: recatOp.fromAccountGuid,
                    });
                    if (!sel.ok) {
                        results.push({ guid, ok: false, error: sel.error });
                        continue;
                    }
                    moveSplit = sel.split;
                    // Hard stop (not a per-transaction skip): moving a
                    // reconciled/frozen split desynchronizes the book from
                    // its statement. Throwing rolls the whole batch back.
                    if (moveSplit) {
                        const liveRow = liveSplitByGuid.get(moveSplit.guid);
                        assertSplitsNotProtected(
                            'recategorize this transaction',
                            liveRow ? [liveRow] : [],
                        );
                    }
                    if (
                        moveSplit &&
                        targetCommodityGuid &&
                        moveSplit.commodityGuid !== targetCommodityGuid
                    ) {
                        results.push({ guid, ok: false, error: 'currency mismatch with target account' });
                        continue;
                    }
                }

                let changed = false;
                let coreChanged = false;
                if (typeof description === 'string') {
                    // enter_date bump invalidates other editors' optimistic locks
                    await dbTx.transactions.update({
                        where: { guid },
                        data: { description, enter_date: bulkEditTimestamp },
                    });
                    changed = true;
                    coreChanged = true;
                } else if (replaceOp) {
                    const current = t.description ?? '';
                    const next = replaceDescription(current, replaceOp.find, replaceOp.replace);
                    if (next !== current) {
                        await dbTx.transactions.update({
                            where: { guid },
                            data: { description: next, enter_date: bulkEditTimestamp },
                        });
                        changed = true;
                        coreChanged = true;
                    }
                }
                if (moveSplit && recatOp) {
                    if (!coreChanged) {
                        // Canonical lock order: take the parent transaction's
                        // row lock (and bump the version token) BEFORE
                        // touching its splits — the PUT/DELETE paths lock in
                        // that order, so the reverse would be an ABBA deadlock.
                        await dbTx.transactions.update({
                            where: { guid },
                            data: { enter_date: bulkEditTimestamp },
                        });
                        coreChanged = true;
                    }
                    await dbTx.splits.update({
                        where: { guid: moveSplit.guid },
                        data: { account_guid: recatOp.toAccountGuid },
                    });
                    changed = true;
                    recategorized = true;
                    if (t.post_date) touchedDates.push(t.post_date);
                }
                if (removeIds.length > 0) {
                    const res = await dbTx.gnucash_web_transaction_tags.deleteMany({
                        where: { transaction_guid: guid, tag_id: { in: removeIds } },
                    });
                    if (res.count > 0) changed = true;
                }
                if (addIds.length > 0) {
                    const res = await dbTx.gnucash_web_transaction_tags.createMany({
                        data: addIds.map(id => ({ transaction_guid: guid, tag_id: id })),
                        skipDuplicates: true,
                    });
                    if (res.count > 0) changed = true;
                }

                results.push({ guid, ok: true });
                if (changed) updated++;
            }
        });

        // Recategorizing splits changes account-scoped dashboard metrics;
        // invalidate caches from the earliest affected transaction date.
        if (recategorized && touchedDates.length > 0) {
            try {
                const earliest = touchedDates.reduce((a, b) => (a < b ? a : b));
                await cacheInvalidateFrom(roleResult.bookGuid, earliest);
            } catch (err) {
                console.warn('Cache invalidation failed:', err);
            }
        }

        if (updated > 0) void publishDataChange(roleResult.bookGuid, 'transactions', { action: 'bulk' });

        return NextResponse.json({
            results,
            updated,
            skipped: results.filter(r => !r.ok).length,
        });
    } catch (error) {
        if (error instanceof PeriodLockedError) {
            return periodLockedResponse(error);
        }
        if (error instanceof ReconciledSplitError) {
            return reconciledSplitResponse(error);
        }
        console.error('Failed to bulk edit transactions:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
