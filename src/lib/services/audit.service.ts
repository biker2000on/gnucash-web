/**
 * Audit Logging Service
 *
 * Audit logging for book mutations (transactions, accounts, budgets,
 * scheduled transactions, tags, invoices), stored in gnucash_web_audit.
 * Transaction entries carry full before/after snapshots (including splits)
 * so they can be undone: restore a deleted transaction, revert an update,
 * or delete a mistaken creation.
 */

import prisma from '@/lib/prisma';
import type { ExtendedPrismaClient } from '@/lib/prisma';
import { getCurrentUser } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { assertNotLocked } from '@/lib/services/period-lock.service';
import { afterLedgerWrite } from '@/lib/data-events';

/** Global client or an interactive-transaction client. */
type DbClient = Omit<
    ExtendedPrismaClient,
    '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE';
export type EntityType =
    | 'TRANSACTION'
    | 'ACCOUNT'
    | 'SPLIT'
    | 'PRICE'
    | 'BUDGET'
    | 'SCHEDULED_TRANSACTION'
    | 'TAG'
    | 'INVOICE'
    | 'REIMBURSEMENT'
    | 'JOB_COST'
    | 'PAYMENT_CONNECTION'
    | 'PAYMENT'
    | 'DOMAIN_COMMAND'
    | 'RESILIENCE';

/**
 * Log an audit event for a mutation operation.
 *
 * @param action - The type of action performed (CREATE, UPDATE, DELETE)
 * @param entityType - The type of entity being modified
 * @param entityId - The GUID of the entity
 * @param oldValues - The old values before the change (null for CREATE)
 * @param newValues - The new values after the change (null for DELETE)
 */
export async function logAudit(
    action: AuditAction,
    entityType: EntityType,
    entityId: string,
    oldValues?: object | null,
    newValues?: object | null,
    context?: { bookGuid?: string | null; userId?: number | null },
): Promise<void> {
    try {
        const user = context?.userId === undefined ? await getCurrentUser() : null;

        // Attribute the entry to the active book; if resolution fails the
        // entry is still written (book_guid null) so the mutation isn't lost.
        let bookGuid: string | null = context?.bookGuid ?? null;
        if (context?.bookGuid === undefined) {
            try {
                bookGuid = await getActiveBookGuid();
            } catch {
                bookGuid = null;
            }
        }

        await prisma.gnucash_web_audit.create({
            data: {
                user_id: context?.userId ?? user?.id ?? null,
                book_guid: bookGuid,
                action,
                entity_type: entityType,
                entity_guid: entityId,
                old_values: oldValues ?? undefined,
                new_values: newValues ?? undefined,
            },
        });
    } catch (error) {
        // Log but don't throw - audit failure shouldn't break the main operation
        console.error('Failed to log audit:', error);
    }
}

// ---------------------------------------------------------------------------
// Transaction snapshots (full fidelity — undo-capable)
// ---------------------------------------------------------------------------

export interface SplitSnapshot {
    guid: string;
    account_guid: string;
    memo: string;
    action: string;
    reconcile_state: string;
    reconcile_date: string | null;
    value_num: string;
    value_denom: string;
    quantity_num: string;
    quantity_denom: string;
    lot_guid: string | null;
}

export interface TransactionSnapshot {
    snapshotVersion: 1;
    guid: string;
    currency_guid: string;
    num: string;
    post_date: string | null;
    enter_date: string | null;
    description: string | null;
    splits: SplitSnapshot[];
}

/** Full transaction snapshot suitable for exact restoration. */
export async function snapshotTransactionByGuid(
    guid: string,
    client: DbClient = prisma,
): Promise<TransactionSnapshot | null> {
    const tx = await client.transactions.findUnique({
        where: { guid },
        include: { splits: true },
    });
    if (!tx) return null;
    return {
        snapshotVersion: 1,
        guid: tx.guid,
        currency_guid: tx.currency_guid,
        num: tx.num,
        post_date: tx.post_date?.toISOString() ?? null,
        enter_date: tx.enter_date?.toISOString() ?? null,
        description: tx.description,
        splits: tx.splits.map(s => ({
            guid: s.guid,
            account_guid: s.account_guid,
            memo: s.memo,
            action: s.action,
            reconcile_state: s.reconcile_state,
            reconcile_date: s.reconcile_date?.toISOString() ?? null,
            value_num: s.value_num.toString(),
            value_denom: s.value_denom.toString(),
            quantity_num: s.quantity_num.toString(),
            quantity_denom: s.quantity_denom.toString(),
            lot_guid: s.lot_guid,
        })),
    };
}

export function isTransactionSnapshot(value: unknown): value is TransactionSnapshot {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return v.snapshotVersion === 1 && typeof v.guid === 'string' && Array.isArray(v.splits);
}

/**
 * Deep equality on the canonical snapshot fields (split order ignored, extra
 * keys like `undo_of_audit_id` ignored). Used to verify, inside the undo
 * transaction, that a transaction's CURRENT state still matches the audit
 * entry's "after" image — if it doesn't, the transaction was edited since and
 * a revert would silently discard those later edits.
 */
export function transactionSnapshotsEqual(a: TransactionSnapshot, b: TransactionSnapshot): boolean {
    const canonSplit = (s: SplitSnapshot) => [
        s.guid, s.account_guid, s.memo, s.action, s.reconcile_state,
        s.reconcile_date ?? '', s.value_num, s.value_denom,
        s.quantity_num, s.quantity_denom, s.lot_guid ?? '',
    ].join('|');
    const canon = (t: TransactionSnapshot) => JSON.stringify({
        guid: t.guid,
        currency_guid: t.currency_guid,
        num: t.num,
        post_date: t.post_date,
        enter_date: t.enter_date,
        description: t.description,
        splits: t.splits.map(canonSplit).sort(),
    });
    return canon(a) === canon(b);
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

export type UndoPlan =
    | { kind: 'restore_deleted'; snapshot: TransactionSnapshot }
    | { kind: 'revert_update'; snapshot: TransactionSnapshot }
    | { kind: 'delete_created'; guid: string };

export interface AuditEntryLike {
    action: string;
    entity_type: string;
    entity_guid: string;
    old_values: unknown;
    new_values: unknown;
}

/**
 * Decide how to undo an audit entry. Returns null (with a reason) when the
 * entry is not undoable — wrong entity type or a legacy shallow snapshot.
 */
export function buildUndoPlan(entry: AuditEntryLike): { plan: UndoPlan | null; reason?: string } {
    if (entry.entity_type !== 'TRANSACTION') {
        return { plan: null, reason: 'Only transaction entries can be undone' };
    }
    switch (entry.action) {
        case 'DELETE':
            if (!isTransactionSnapshot(entry.old_values)) {
                return { plan: null, reason: 'This entry predates full snapshots and cannot be restored' };
            }
            return { plan: { kind: 'restore_deleted', snapshot: entry.old_values } };
        case 'UPDATE':
            if (!isTransactionSnapshot(entry.old_values)) {
                return { plan: null, reason: 'This entry predates full snapshots and cannot be reverted' };
            }
            return { plan: { kind: 'revert_update', snapshot: entry.old_values } };
        case 'CREATE':
            return { plan: { kind: 'delete_created', guid: entry.entity_guid } };
        default:
            return { plan: null, reason: `Unknown action: ${entry.action}` };
    }
}

/** Write a snapshot within the caller's transaction (claim-first callers). */
async function writeSnapshot(tx: DbClient, snapshot: TransactionSnapshot, replaceExisting: boolean): Promise<void> {
    if (replaceExisting) {
        // The slots table has no FK on obj_guid: splits that exist now but
        // are NOT part of the restored snapshot are gone for good, so their
        // slots (lot-engine markers etc.) must go too. Splits recreated below
        // under the same guid keep their slots; the transaction row is
        // recreated under the same guid, so its slots stay attached.
        const currentSplits = await tx.splits.findMany({
            where: { tx_guid: snapshot.guid },
            select: { guid: true },
        });
        const restoredGuids = new Set(snapshot.splits.map(s => s.guid));
        const removedGuids = currentSplits.map(s => s.guid).filter(g => !restoredGuids.has(g));
        if (removedGuids.length > 0) {
            await tx.slots.deleteMany({ where: { obj_guid: { in: removedGuids } } });
        }
        await tx.splits.deleteMany({ where: { tx_guid: snapshot.guid } });
        await tx.transactions.deleteMany({ where: { guid: snapshot.guid } });
    } else {
        const exists = await tx.transactions.findUnique({ where: { guid: snapshot.guid } });
        if (exists) {
            throw new UndoConflictError('Transaction already exists — it may have been restored already');
        }
    }
    await tx.transactions.create({
        data: {
            guid: snapshot.guid,
            currency_guid: snapshot.currency_guid,
            num: snapshot.num,
            post_date: snapshot.post_date ? new Date(snapshot.post_date) : null,
            enter_date: snapshot.enter_date ? new Date(snapshot.enter_date) : null,
            description: snapshot.description,
        },
    });
    for (const s of snapshot.splits) {
        // Lots may have been deleted since the snapshot — drop dangling refs
        const lotGuid = s.lot_guid
            ? (await tx.lots.findUnique({ where: { guid: s.lot_guid } })) ? s.lot_guid : null
            : null;
        await tx.splits.create({
            data: {
                guid: s.guid,
                tx_guid: snapshot.guid,
                account_guid: s.account_guid,
                memo: s.memo,
                action: s.action,
                reconcile_state: s.reconcile_state,
                reconcile_date: s.reconcile_date ? new Date(s.reconcile_date) : null,
                value_num: BigInt(s.value_num),
                value_denom: BigInt(s.value_denom),
                quantity_num: BigInt(s.quantity_num),
                quantity_denom: BigInt(s.quantity_denom),
                lot_guid: lotGuid,
            },
        });
    }
}

/** Aborts the undo transaction with a user-facing conflict message (→ 409). */
class UndoConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UndoConflictError';
    }
}

class AlreadyUndoneError extends UndoConflictError {
    constructor() {
        super('This entry has already been undone');
        this.name = 'AlreadyUndoneError';
    }
}

/**
 * Claim-first idempotency (recurring-invoices pattern): atomically stamp
 * undone_at as the FIRST write of the undo transaction. Zero rows means a
 * concurrent (or earlier) undo won the claim — abort so nothing is applied
 * twice. Rollback of the surrounding transaction releases the claim on
 * failure, so a failed undo stays retryable.
 */
async function claimUndo(tx: DbClient, auditId: number, userId: number | null): Promise<void> {
    const claimed = await tx.$queryRaw<Array<{ id: number }>>`
        UPDATE gnucash_web_audit
        SET undone_at = NOW(), undone_by = ${userId}
        WHERE id = ${auditId} AND undone_at IS NULL
        RETURNING id
    `;
    if (claimed.length === 0) throw new AlreadyUndoneError();
}

export interface UndoResult {
    ok: boolean;
    message: string;
    /** What happened, for the follow-up audit entry. */
    action?: AuditAction;
}

/**
 * Execute the undo for one audit entry and log the undo itself.
 * The entry must belong to `activeBookGuid` — entries from other books (or
 * unattributable legacy rows with a NULL book_guid) are reported as not found
 * so a user cannot undo another book's mutations by id.
 */
export async function undoAuditEntry(auditId: number, activeBookGuid: string): Promise<UndoResult> {
    const entry = await prisma.gnucash_web_audit.findUnique({ where: { id: auditId } });
    if (!entry || entry.book_guid !== activeBookGuid) {
        return { ok: false, message: 'Audit entry not found' };
    }

    // Fast pre-check for friendliness; the authoritative guard is the atomic
    // claim (undone_at CAS) inside the transaction below.
    const undone = await prisma.$queryRaw<Array<{ id: number }>>`
        SELECT id FROM gnucash_web_audit WHERE id = ${auditId} AND undone_at IS NOT NULL
    `;
    if (undone.length > 0) return { ok: false, message: 'This entry has already been undone' };

    const { plan, reason } = buildUndoPlan(entry);
    if (!plan) return { ok: false, message: reason ?? 'Not undoable' };

    let user: Awaited<ReturnType<typeof getCurrentUser>> = null;
    try {
        user = await getCurrentUser();
    } catch {
        user = null;
    }
    const userId = user?.id ?? null;

    try {
        switch (plan.kind) {
            case 'restore_deleted': {
                // Period lock: restoring re-creates a transaction at its old date
                await assertNotLocked(activeBookGuid, [plan.snapshot.post_date]);
                await prisma.$transaction(async (tx) => {
                    await claimUndo(tx, auditId, userId);
                    await writeSnapshot(tx, plan.snapshot, false);
                });
                await logAudit('CREATE', 'TRANSACTION', plan.snapshot.guid, null, {
                    ...plan.snapshot,
                    undo_of_audit_id: auditId,
                });
                afterLedgerWrite(activeBookGuid, 'transactions', { guid: plan.snapshot.guid, action: 'create' });
                return { ok: true, message: 'Transaction restored', action: 'CREATE' };
            }
            case 'revert_update': {
                const probe = await snapshotTransactionByGuid(plan.snapshot.guid);
                if (!probe) return { ok: false, message: 'Transaction no longer exists — restore it from its DELETE entry instead' };
                // Period lock: both the current date and the reverted-to date must be open
                await assertNotLocked(activeBookGuid, [probe.post_date, plan.snapshot.post_date]);
                const current = await prisma.$transaction(async (tx) => {
                    await claimUndo(tx, auditId, userId);
                    // Re-read INSIDE the transaction: the pre-check above ran on a
                    // stale snapshot that a concurrent edit may have invalidated.
                    const live = await snapshotTransactionByGuid(plan.snapshot.guid, tx);
                    if (!live) {
                        throw new UndoConflictError('Transaction no longer exists — restore it from its DELETE entry instead');
                    }
                    // Refuse when the transaction moved on past this entry's "after"
                    // image — reverting would silently discard those later edits.
                    if (isTransactionSnapshot(entry.new_values) && !transactionSnapshotsEqual(live, entry.new_values)) {
                        throw new UndoConflictError(
                            'The transaction has been edited since this entry — undoing it now would discard those later changes. Undo the newer entries first.',
                        );
                    }
                    await writeSnapshot(tx, plan.snapshot, true);
                    return live;
                });
                await logAudit('UPDATE', 'TRANSACTION', plan.snapshot.guid, current, {
                    ...plan.snapshot,
                    undo_of_audit_id: auditId,
                });
                afterLedgerWrite(activeBookGuid, 'transactions', { guid: plan.snapshot.guid, action: 'update' });
                return { ok: true, message: 'Transaction reverted to its previous state', action: 'UPDATE' };
            }
            case 'delete_created': {
                const probe = await snapshotTransactionByGuid(plan.guid);
                if (!probe) return { ok: false, message: 'Transaction no longer exists' };
                // Period lock: transactions dated in a closed period cannot be deleted
                await assertNotLocked(activeBookGuid, [probe.post_date]);
                const current = await prisma.$transaction(async (tx) => {
                    await claimUndo(tx, auditId, userId);
                    const live = await snapshotTransactionByGuid(plan.guid, tx);
                    if (!live) throw new UndoConflictError('Transaction no longer exists');
                    // Slots have no FK — the deleted splits' and the
                    // transaction's slots must be removed with them.
                    await tx.slots.deleteMany({
                        where: { obj_guid: { in: [...live.splits.map(s => s.guid), plan.guid] } },
                    });
                    await tx.splits.deleteMany({ where: { tx_guid: plan.guid } });
                    await tx.transactions.delete({ where: { guid: plan.guid } });
                    return live;
                });
                await logAudit('DELETE', 'TRANSACTION', plan.guid, { ...current, undo_of_audit_id: auditId }, null);
                afterLedgerWrite(activeBookGuid, 'transactions', { guid: plan.guid, action: 'delete' });
                return { ok: true, message: 'Transaction deleted', action: 'DELETE' };
            }
        }
    } catch (error) {
        if (error instanceof UndoConflictError) {
            return { ok: false, message: error.message };
        }
        throw error;
    }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface AuditListFilters {
    /** Active book — only this book's entries are returned (NULL rows excluded). */
    bookGuid: string;
    limit?: number;
    offset?: number;
    entityType?: EntityType;
    action?: AuditAction;
    entityGuid?: string;
}

export async function listAuditEntries(filters: AuditListFilters) {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    // Equality also excludes unattributable legacy rows (book_guid IS NULL).
    const where: Record<string, unknown> = { book_guid: filters.bookGuid };
    if (filters.entityType) where.entity_type = filters.entityType;
    if (filters.action) where.action = filters.action;
    if (filters.entityGuid) where.entity_guid = filters.entityGuid;

    const [entries, total] = await Promise.all([
        prisma.gnucash_web_audit.findMany({
            where,
            orderBy: { created_at: 'desc' },
            take: limit,
            skip: offset,
            include: { user: { select: { username: true, display_name: true } } },
        }),
        prisma.gnucash_web_audit.count({ where }),
    ]);

    // undone_at lives outside the Prisma model (added by db-init DDL) — read
    // it raw for the page so undone entries stop being offered as undoable.
    const ids = entries.map(e => e.id);
    const undoneRows = ids.length > 0
        ? await prisma.$queryRaw<Array<{ id: number; undone_at: Date }>>`
            SELECT id, undone_at FROM gnucash_web_audit
            WHERE id = ANY(${ids}::int[]) AND undone_at IS NOT NULL
        `
        : [];
    const undoneById = new Map(undoneRows.map(r => [r.id, r.undone_at]));

    return {
        total,
        entries: entries.map(e => ({
            id: e.id,
            action: e.action,
            entityType: e.entity_type,
            entityGuid: e.entity_guid,
            oldValues: e.old_values,
            newValues: e.new_values,
            createdAt: e.created_at.toISOString(),
            user: e.user ? (e.user.display_name || e.user.username) : null,
            undoneAt: undoneById.get(e.id)?.toISOString() ?? null,
            undoable: !undoneById.has(e.id) && buildUndoPlan(e).plan !== null,
        })),
    };
}
