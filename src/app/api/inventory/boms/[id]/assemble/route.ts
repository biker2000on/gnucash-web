import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { assembleBom } from '@/lib/inventory-engine';
import { mapInventoryError } from '@/lib/inventory-api-errors';

/**
 * POST /api/inventory/boms/[id]/assemble — build batches of a BOM.
 * Body: { batches, locationId, date?, reference?, post? }
 *   Consumes each component (quantityPerBatch × batches at its average cost)
 *   and produces outputQuantity × batches units whose unit cost is the total
 *   consumed cost divided by the produced quantity. post=true writes an asset
 *   transfer txn between differing component/output asset accounts.
 * Response 201: { consumed: InventoryMovement[], produced: InventoryMovement,
 *                 totalCost, unitCost, producedQuantity, txnGuid, reference }
 * Errors: 400 validation, 404 unknown BOM, 409 insufficient component stock.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const bomId = parseInt((await params).id, 10);
    if (!Number.isInteger(bomId) || bomId <= 0) {
      return NextResponse.json({ error: 'Invalid BOM id' }, { status: 400 });
    }

    const body = await request.json();
    if (typeof body.batches !== 'number' || typeof body.locationId !== 'number') {
      return NextResponse.json(
        { error: 'batches and locationId are required numbers' },
        { status: 400 },
      );
    }

    const result = await assembleBom({
      bookGuid: roleResult.bookGuid,
      bomId,
      batches: body.batches,
      locationId: body.locationId,
      date: body.date,
      reference: body.reference,
      post: body.post,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return mapInventoryError(error);
  }
}
