import { NextResponse } from 'next/server';
import prisma, { toDecimal, generateGuid } from '@/lib/prisma';
import { serializeBigInts } from '@/lib/gnucash';
import { CreateTransactionRequest } from '@/lib/types';
import { validateTransaction } from '@/lib/validation';
import { logAudit, snapshotTransactionByGuid } from '@/lib/services/audit.service';
import { processMultiCurrencySplits } from '@/lib/trading-accounts';
import { getBookAccountGuids, getActiveBookGuid } from '@/lib/book-scope';
import { cacheInvalidateFrom } from '@/lib/cache';
import { publishDataChange } from '@/lib/data-events';
import { requireRole } from '@/lib/auth';
import {
    assertNotLocked,
    PeriodLockedError,
    periodLockedResponse,
} from '@/lib/services/period-lock.service';

/** Thrown inside the DB transaction when the optimistic version check fails. */
class TransactionConflictError extends Error {
    constructor() {
        super('Transaction was modified by another user');
        this.name = 'TransactionConflictError';
    }
}

/** Thrown inside the DB transaction when the row no longer exists. */
class TransactionNotFoundError extends Error {
    constructor() {
        super('Transaction not found');
        this.name = 'TransactionNotFoundError';
    }
}

/**
 * Parse the client-supplied optimistic-lock token. Returns:
 * - { ok: true, value: Date | null }  — valid token (null = "row had no enter_date")
 * - { ok: false }                     — malformed value
 */
function parseEnterDateToken(raw: unknown): { ok: true; value: Date | null } | { ok: false } {
    if (raw === null) return { ok: true, value: null };
    if (typeof raw !== 'string' || raw.length === 0) return { ok: false };
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return { ok: false };
    return { ok: true, value: parsed };
}

/** Compare the locked row's enter_date against the client token. */
function enterDateMatches(current: Date | null, expected: Date | null): boolean {
    if (current === null || expected === null) return current === expected;
    return current.getTime() === expected.getTime();
}

export async function GET(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;

        // Verify transaction belongs to active book
        const bookAccountGuids = await getBookAccountGuids();
        const txCheck = await prisma.transactions.findFirst({
            where: {
                guid,
                splits: { some: { account_guid: { in: bookAccountGuids } } },
            },
            select: { guid: true },
        });
        if (!txCheck) {
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
        }

        // Fetch transaction with splits
        const transaction = await prisma.transactions.findUnique({
            where: { guid },
            include: {
                splits: {
                    include: {
                        account: {
                            include: {
                                commodity: true,
                            },
                        },
                    },
                    orderBy: {
                        value_num: 'desc',
                    },
                },
            },
        });

        if (!transaction) {
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
        }

        // Get account fullnames from account_hierarchy view
        const accountGuids = transaction.splits.map(s => s.account_guid);
        const accountHierarchy = await prisma.$queryRaw<{ guid: string; fullname: string }[]>`
            SELECT guid, fullname FROM account_hierarchy WHERE guid = ANY(${accountGuids}::text[])
        `;
        const fullnameMap = new Map(accountHierarchy.map(a => [a.guid, a.fullname]));

        // Transaction currency (splits' values are denominated in it)
        const currency = await prisma.commodities.findUnique({
            where: { guid: transaction.currency_guid },
            select: { mnemonic: true },
        });

        // App-extension meta: import source and the preserved import-time
        // payee (original_description) so the detail surface can show what
        // the bank line originally said after a rename.
        const meta = await prisma.gnucash_web_transaction_meta.findUnique({
            where: { transaction_guid: guid },
            select: {
                source: true,
                reviewed: true,
                match_type: true,
                original_description: true,
            },
        });

        // Transform to response format
        const result = {
            guid: transaction.guid,
            currency_guid: transaction.currency_guid,
            currency_mnemonic: currency?.mnemonic ?? 'USD',
            num: transaction.num,
            post_date: transaction.post_date,
            enter_date: transaction.enter_date,
            description: transaction.description,
            source: meta?.source ?? 'manual',
            reviewed: meta?.reviewed ?? true,
            match_type: meta?.match_type ?? null,
            original_description: meta?.original_description ?? null,
            splits: transaction.splits.map(split => ({
                guid: split.guid,
                tx_guid: split.tx_guid,
                account_guid: split.account_guid,
                memo: split.memo,
                action: split.action,
                reconcile_state: split.reconcile_state,
                reconcile_date: split.reconcile_date,
                value_num: split.value_num,
                value_denom: split.value_denom,
                quantity_num: split.quantity_num,
                quantity_denom: split.quantity_denom,
                lot_guid: split.lot_guid,
                account_name: split.account.name,
                account_fullname: fullnameMap.get(split.account_guid) || split.account.name,
                commodity_mnemonic: split.account.commodity?.mnemonic,
                value_decimal: toDecimal(split.value_num, split.value_denom),
                quantity_decimal: toDecimal(split.quantity_num, split.quantity_denom),
            })),
        };

        return NextResponse.json(serializeBigInts(result));
    } catch (error) {
        console.error('Error fetching transaction:', error);
        return NextResponse.json({ error: 'Failed to fetch transaction' }, { status: 500 });
    }
}

export async function PUT(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        const rawBody = await request.json();
        const { original_enter_date, ...bodyData } = rawBody;
        const body: CreateTransactionRequest = bodyData;

        // Optimistic concurrency is mandatory: the client must echo back the
        // enter_date it loaded (or null when the row had none). Without it we
        // cannot detect concurrent edits, so refuse with 428 Precondition
        // Required.
        if (!('original_enter_date' in rawBody) || original_enter_date === undefined) {
            return NextResponse.json({
                error: 'original_enter_date is required: send the enter_date value you loaded '
                    + '(or null if it was empty) so concurrent edits can be detected.',
                code: 'original_enter_date_required',
            }, { status: 428 });
        }
        const enterDateToken = parseEnterDateToken(original_enter_date);
        if (!enterDateToken.ok) {
            return NextResponse.json({
                error: 'original_enter_date must be an ISO date string or null',
            }, { status: 400 });
        }

        // Validate the transaction
        const validation = validateTransaction(body);
        if (!validation.valid) {
            return NextResponse.json({
                error: validation.errors.map(item => item.message).join(' '),
                errors: validation.errors,
            }, { status: 400 });
        }

        // Verify all account GUIDs exist (deduplicate since multiple splits can reference the same account)
        const uniqueAccountGuids = [...new Set(body.splits.map(s => s.account_guid))];
        const accounts = await prisma.accounts.findMany({
            where: {
                guid: { in: uniqueAccountGuids },
            },
            select: { guid: true },
        });

        if (accounts.length !== uniqueAccountGuids.length) {
            const foundGuids = new Set(accounts.map(a => a.guid));
            const missingGuids = uniqueAccountGuids.filter(g => !foundGuids.has(g));
            return NextResponse.json({
                errors: [{ field: 'splits', message: `Invalid account GUIDs: ${missingGuids.join(', ')}` }]
            }, { status: 400 });
        }

        // Validate client-provided split GUIDs
        for (const split of body.splits) {
            if (split.guid !== undefined && !/^[0-9a-f]{32}$/.test(split.guid)) {
                return NextResponse.json({
                    errors: [{ field: 'splits', message: `Invalid split GUID format: ${split.guid}. Must be 32-char hex string.` }]
                }, { status: 400 });
            }
        }

        // Update transaction and recreate splits in a transaction. All state
        // reads (row lock + version check, period-lock check, before-image,
        // live split snapshot) happen INSIDE the transaction so a concurrent
        // writer cannot slip in between check and write.
        const { transaction, beforeSnapshot } = await prisma.$transaction(async (tx) => {
            // Lock the transaction row so the version check below is
            // race-proof: concurrent editors serialize here.
            const lockedRows = await tx.$queryRaw<
                { guid: string; enter_date: Date | null; post_date: Date | null }[]
            >`
                SELECT guid, enter_date, post_date
                FROM transactions
                WHERE guid = ${guid}
                FOR UPDATE
            `;
            if (lockedRows.length === 0) {
                throw new TransactionNotFoundError();
            }
            const lockedTx = lockedRows[0];

            // Optimistic concurrency: the row's enter_date must still match
            // what the client loaded. The row is locked, so this cannot race.
            if (!enterDateMatches(lockedTx.enter_date, enterDateToken.value)) {
                throw new TransactionConflictError();
            }

            // Period lock (authoritative, in-transaction, cache bypassed):
            // both the transaction's current date and its new date must be
            // after the lock date.
            await assertNotLocked(
                roleResult.bookGuid,
                [lockedTx.post_date, body.post_date],
                { bypassCache: true, client: tx },
            );

            // Full before-image for the audit trail (undo-capable). The row is
            // locked and unmodified at this point, so the committed state the
            // snapshot reads is exactly the state we are about to replace.
            // Read via the transaction client so it shares this transaction's
            // connection instead of grabbing a second pool connection.
            const beforeImage = await snapshotTransactionByGuid(guid, tx);

            // Live split state (reconcile/lot preservation must not use a
            // stale pre-transaction snapshot).
            const existingSplits = await tx.splits.findMany({
                where: { tx_guid: guid },
            });
            const existingSplitByGuid = new Map(existingSplits.map(split => [split.guid, split]));

            // Process multi-currency splits and add trading splits if needed
            const multiCurrencyResult = await processMultiCurrencySplits(
                body.splits,
                tx
            );
            const allSplits = multiCurrencyResult.allSplits;

            // Update transaction; enter_date is always bumped to a fresh
            // timestamp so every sibling writer's optimistic check invalidates.
            await tx.transactions.update({
                where: { guid },
                data: {
                    currency_guid: body.currency_guid,
                    num: body.num || '',
                    post_date: new Date(body.post_date),
                    enter_date: new Date(),
                    description: body.description,
                },
            });

            // Delete existing splits
            await tx.splits.deleteMany({
                where: { tx_guid: guid },
            });

            // Insert all splits (including auto-generated trading splits)
            for (const split of allSplits) {
                const splitGuid = split.guid && /^[0-9a-f]{32}$/.test(split.guid) ? split.guid : generateGuid();
                const existingSplit = existingSplitByGuid.get(splitGuid);
                await tx.splits.create({
                    data: {
                        guid: splitGuid,
                        tx_guid: guid,
                        account_guid: split.account_guid,
                        memo: split.memo || '',
                        action: split.action ?? existingSplit?.action ?? '',
                        reconcile_state: split.reconcile_state || 'n',
                        reconcile_date:
                            existingSplit && existingSplit.reconcile_state === (split.reconcile_state || 'n')
                                ? existingSplit.reconcile_date
                                : null,
                        value_num: BigInt(split.value_num),
                        value_denom: BigInt(split.value_denom),
                        quantity_num: BigInt(split.quantity_num),
                        quantity_denom: BigInt(split.quantity_denom),
                        lot_guid: existingSplit?.lot_guid ?? null,
                    },
                });
            }

            // Return the updated transaction with splits
            const updated = await tx.transactions.findUnique({
                where: { guid },
                include: {
                    splits: {
                        include: {
                            account: {
                                include: {
                                    commodity: true,
                                },
                            },
                        },
                        orderBy: {
                            value_num: 'desc',
                        },
                    },
                },
            });
            return { transaction: updated, beforeSnapshot: beforeImage };
        }, {
            maxWait: 30_000,
            // Single-transaction saves never legitimately take minutes; a
            // long timeout only turns a row-lock wait into a multi-minute
            // stall for the user.
            timeout: 30_000,
        });

        if (!transaction) {
            throw new Error('Failed to update transaction');
        }

        // Log audit event with full before/after snapshots (undo-capable)
        const afterSnapshot = await snapshotTransactionByGuid(guid);
        await logAudit('UPDATE', 'TRANSACTION', guid, beforeSnapshot, afterSnapshot);

        // Invalidate caches from the transaction date forward
        try {
            const bookGuid = await getActiveBookGuid();
            const txDate = new Date(body.post_date);
            await cacheInvalidateFrom(bookGuid, txDate);
        } catch (err) {
            // Cache invalidation failure should not break the transaction operation
            console.warn('Cache invalidation failed:', err);
        }

        // Transform to response format
        const result = {
            guid: transaction.guid,
            currency_guid: transaction.currency_guid,
            num: transaction.num,
            post_date: transaction.post_date,
            enter_date: transaction.enter_date,
            description: transaction.description,
            splits: transaction.splits.map(split => ({
                guid: split.guid,
                tx_guid: split.tx_guid,
                account_guid: split.account_guid,
                memo: split.memo,
                action: split.action,
                reconcile_state: split.reconcile_state,
                reconcile_date: split.reconcile_date,
                value_num: split.value_num,
                value_denom: split.value_denom,
                quantity_num: split.quantity_num,
                quantity_denom: split.quantity_denom,
                lot_guid: split.lot_guid,
                account_name: split.account.name,
                commodity_mnemonic: split.account.commodity?.mnemonic,
                value_decimal: toDecimal(split.value_num, split.value_denom),
                quantity_decimal: toDecimal(split.quantity_num, split.quantity_denom),
            })),
        };

        void publishDataChange(roleResult.bookGuid, 'transactions', { guid, action: 'update' });

        return NextResponse.json(serializeBigInts(result));
    } catch (error) {
        if (error instanceof TransactionNotFoundError) {
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
        }
        if (error instanceof TransactionConflictError) {
            return NextResponse.json(
                { error: 'Transaction was modified by another user', code: 'conflict' },
                { status: 409 }
            );
        }
        if (error instanceof PeriodLockedError) {
            return periodLockedResponse(error);
        }
        console.error('Error updating transaction:', error);
        return NextResponse.json({ error: 'Failed to update transaction' }, { status: 500 });
    }
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;

        // MANDATORY optimistic-lock token (same contract as PUT): query param
        // first, then JSON body. Deleting blind is the same lost-update as
        // overwriting blind — a script deleting what another user just
        // corrected must 409, not silently destroy the correction.
        const { searchParams } = new URL(request.url);
        let rawToken: unknown = searchParams.get('original_enter_date');
        if (rawToken === null) {
            const jsonBody = await request.json().catch(() => null);
            if (jsonBody && typeof jsonBody === 'object' && 'original_enter_date' in jsonBody) {
                rawToken = (jsonBody as { original_enter_date: unknown }).original_enter_date;
            } else {
                rawToken = undefined;
            }
        } else if (rawToken === 'null') {
            // Query-param encoding of an explicit null token
            rawToken = null;
        }
        if (rawToken === undefined) {
            return NextResponse.json({
                error: 'original_enter_date is required: send the enter_date value you loaded '
                    + '(query param or JSON body) so a concurrent edit is detected instead of destroyed.',
                code: 'original_enter_date_required',
            }, { status: 428 });
        }
        const enterDateToken = parseEnterDateToken(rawToken);
        if (!enterDateToken.ok) {
            return NextResponse.json({
                error: 'original_enter_date must be an ISO date string or null',
            }, { status: 400 });
        }

        // Everything — row lock + version check, period-lock check, snapshot,
        // extension-meta cleanup, and the deletes — runs in one transaction so
        // a failed delete cannot leave the SimpleFin dedup meta destroyed.
        const { deleteSnapshot, deletedPostDate } = await prisma.$transaction(async (tx) => {
            const lockedRows = await tx.$queryRaw<
                { guid: string; enter_date: Date | null; post_date: Date | null; description: string | null }[]
            >`
                SELECT guid, enter_date, post_date, description
                FROM transactions
                WHERE guid = ${guid}
                FOR UPDATE
            `;
            if (lockedRows.length === 0) {
                throw new TransactionNotFoundError();
            }
            const lockedTx = lockedRows[0];

            if (!enterDateMatches(lockedTx.enter_date, enterDateToken.value)) {
                throw new TransactionConflictError();
            }

            // Period lock (authoritative, in-transaction, cache bypassed):
            // transactions dated in a closed period cannot be deleted.
            await assertNotLocked(roleResult.bookGuid, [lockedTx.post_date], { bypassCache: true, client: tx });

            // Full before-image for the audit trail (restore-capable). Row is
            // locked and our deletes have not run yet, so this is consistent.
            // Read via the transaction client so it shares this transaction's
            // connection instead of grabbing a second pool connection.
            const snapshot = await snapshotTransactionByGuid(guid, tx);
            const splitCount = await tx.splits.count({ where: { tx_guid: guid } });

            // Preserve SimpleFin meta rows for dedup (NULL out transaction_guid, mark deleted)
            await tx.$executeRaw`
                UPDATE gnucash_web_transaction_meta
                SET transaction_guid = NULL, deleted_at = NOW()
                WHERE transaction_guid = ${guid}
                  AND simplefin_transaction_id IS NOT NULL
            `;

            // Clean up meta rows for non-SimpleFin transactions
            await tx.$executeRaw`
                DELETE FROM gnucash_web_transaction_meta
                WHERE transaction_guid = ${guid}
                  AND simplefin_transaction_id IS NULL
            `;

            // Delete splits first (even though cascade should handle it)
            await tx.splits.deleteMany({
                where: { tx_guid: guid },
            });

            // Delete transaction
            await tx.transactions.delete({
                where: { guid },
            });

            return {
                deleteSnapshot: snapshot ?? {
                    description: lockedTx.description,
                    post_date: lockedTx.post_date,
                    splits_count: splitCount,
                },
                deletedPostDate: lockedTx.post_date,
            };
        }, {
            maxWait: 30_000,
            timeout: 30_000,
        });

        // Log audit event with the full before-image (restore-capable)
        await logAudit('DELETE', 'TRANSACTION', guid, deleteSnapshot, null);

        // Invalidate caches from the transaction date forward
        try {
            const bookGuid = await getActiveBookGuid();
            if (deletedPostDate) {
                const txDate = new Date(deletedPostDate);
                await cacheInvalidateFrom(bookGuid, txDate);
            }
        } catch (err) {
            // Cache invalidation failure should not break the transaction operation
            console.warn('Cache invalidation failed:', err);
        }

        void publishDataChange(roleResult.bookGuid, 'transactions', { guid, action: 'delete' });

        return NextResponse.json({ success: true, deleted: guid });
    } catch (error) {
        if (error instanceof TransactionNotFoundError) {
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
        }
        if (error instanceof TransactionConflictError) {
            return NextResponse.json(
                { error: 'Transaction was modified by another user', code: 'conflict' },
                { status: 409 }
            );
        }
        if (error instanceof PeriodLockedError) {
            return periodLockedResponse(error);
        }
        console.error('Error deleting transaction:', error);
        return NextResponse.json({ error: 'Failed to delete transaction' }, { status: 500 });
    }
}
