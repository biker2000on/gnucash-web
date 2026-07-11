import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { scanInventoryReorder } from '@/lib/services/inventory.service';
import { mapInventoryError } from '@/lib/inventory-api-errors';

/**
 * POST /api/inventory/reorder-scan
 * Manually scan the book's active items with a reorder point set and create
 * notifications for items whose total on-hand is at or below the point
 * (deduped by source='inventory-reorder' + item/point key — same pattern as
 * the budget alert scan).
 * Response: { detected, created }
 */
export async function POST() {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const result = await scanInventoryReorder(bookGuid, { userId: user.id });
    return NextResponse.json(result);
  } catch (error) {
    return mapInventoryError(error);
  }
}
