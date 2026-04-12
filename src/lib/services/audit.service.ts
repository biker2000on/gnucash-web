/**
 * Audit Logging Service
 *
 * Provides audit logging for transaction mutations (create, update, delete).
 * Logs are stored in the gnucash_web_audit table.
 */

import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/auth';

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE';
export type EntityType = 'TRANSACTION' | 'ACCOUNT' | 'SPLIT' | 'PRICE';

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

        await prisma.gnucash_web_audit.create({
            data: {
                user_id: user?.id ?? null,
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
