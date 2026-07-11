import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookRootGuid } from '@/lib/book-scope';
import { bootstrapInventoryAccounts } from '@/lib/inventory-engine';
import { mapInventoryError } from '@/lib/inventory-api-errors';

/**
 * POST /api/inventory/bootstrap-accounts
 * Creates (or finds) the default 'Inventory' ASSET and 'Cost of Goods Sold'
 * EXPENSE accounts under the active book root.
 * Response 201: { assetAccountGuid, cogsAccountGuid }
 */
export async function POST() {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const rootGuid = await getActiveBookRootGuid();
        const result = await bootstrapInventoryAccounts(rootGuid);
        return NextResponse.json(result, { status: 201 });
    } catch (error) {
        return mapInventoryError(error);
    }
}
