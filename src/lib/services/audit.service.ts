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
import { getCurrentUser } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { assertNotLocked } from '@/lib/services/period-lock.service';

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE';
export type EntityType =
    | 'TRANSACTION'
    | 'ACCOUNT'
    | 'SPLIT'
    | 'PRICE'
    | 'BUDGET'
    | 'SCHEDULED_TRANSACTION'
    | 'TAG'
    | 'INVOICE';

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
    newValues?: object | null
): Promise<void> {
    try {
        const user = await getCurrentUser();

        // Attribute the entry to the active book; if resolution fails the
        // entry is still written (book_guid null) so the mutation isn't lost.
        let bookGuid: string | null = null;
        try {
            bookGuid = await getActiveBookGuid();
        } catch {
            bookGuid = null;
        }

        await prisma.gnucash_web_audit.create({
            data: {
                user_id: user?.id ?? null,
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
export async function snapshotTransactionByGuid(guid: string): Promise<TransactionSnapshot | null> {
    const tx = await prisma.transactions.findUnique({
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

async function writeSnapshot(snapshot: TransactionSnapshot, replaceExisting: boolean): Promise<void> {
    await prisma.$transaction(async (tx) => {
        if (replaceExisting) {
            await tx.splits.deleteMany({ where: { tx_guid: snapshot.guid } });
            await tx.transactions.deleteMany({ where: { guid: snapshot.guid } });
        } else {
            const exists = await tx.transactions.findUnique({ where: { guid: snapshot.guid } });
            if (exists) {
                throw new Error('Transaction already exists — it may have been restored already');
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
    });
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

    const { plan, reason } = buildUndoPlan(entry);
    if (!plan) return { ok: false, message: reason ?? 'Not undoable' };

    switch (plan.kind) {
        case 'restore_deleted': {
            // Period lock: restoring re-creates a transaction at its old date
            await assertNotLocked(activeBookGuid, [plan.snapshot.post_date]);
            await writeSnapshot(plan.snapshot, false);
            await logAudit('CREATE', 'TRANSACTION', plan.snapshot.guid, null, {
                ...plan.snapshot,
                undo_of_audit_id: auditId,
            });
            return { ok: true, message: 'Transaction restored', action: 'CREATE' };
        }
        case 'revert_update': {
            const current = await snapshotTransactionByGuid(plan.snapshot.guid);
            if (!current) return { ok: false, message: 'Transaction no longer exists — restore it from its DELETE entry instead' };
            // Period lock: both the current date and the reverted-to date must be open
            await assertNotLocked(activeBookGuid, [current.post_date, plan.snapshot.post_date]);
            await writeSnapshot(plan.snapshot, true);
            await logAudit('UPDATE', 'TRANSACTION', plan.snapshot.guid, current, {
                ...plan.snapshot,
                undo_of_audit_id: auditId,
            });
            return { ok: true, message: 'Transaction reverted to its previous state', action: 'UPDATE' };
        }
        case 'delete_created': {
            const current = await snapshotTransactionByGuid(plan.guid);
            if (!current) return { ok: false, message: 'Transaction no longer exists' };
            // Period lock: transactions dated in a closed period cannot be deleted
            await assertNotLocked(activeBookGuid, [current.post_date]);
            await prisma.$transaction(async (tx) => {
                await tx.splits.deleteMany({ where: { tx_guid: plan.guid } });
                await tx.transactions.delete({ where: { guid: plan.guid } });
            });
            await logAudit('DELETE', 'TRANSACTION', plan.guid, { ...current, undo_of_audit_id: auditId }, null);
            return { ok: true, message: 'Transaction deleted', action: 'DELETE' };
        }
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
            undoable: buildUndoPlan(e).plan !== null,
        })),
    };
}
