import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { listMovements, type MovementType } from '@/lib/services/inventory.service';
import { receiveStock, shipStock, adjustStock, transferStock } from '@/lib/inventory-engine';
import { mapInventoryError } from '@/lib/inventory-api-errors';

/**
 * GET /api/inventory/movements
 * Query params: itemId, locationId, type=<movement type>, dateFrom, dateTo
 *   (YYYY-MM-DD, inclusive), invoiceGuid, limit (default 100, max 500), offset
 * Response: { movements: InventoryMovement[], total: number }
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const intParam = (name: string) =>
      searchParams.get(name) ? parseInt(searchParams.get(name)!, 10) : undefined;

    const result = await listMovements(roleResult.bookGuid, {
      itemId: intParam('itemId'),
      locationId: intParam('locationId'),
      movementType: (searchParams.get('type') as MovementType) ?? undefined,
      dateFrom: searchParams.get('dateFrom') ?? undefined,
      dateTo: searchParams.get('dateTo') ?? undefined,
      invoiceGuid: searchParams.get('invoiceGuid') ?? undefined,
      limit: intParam('limit'),
      offset: intParam('offset'),
    });
    return NextResponse.json(result);
  } catch (error) {
    return mapInventoryError(error);
  }
}

/**
 * POST /api/inventory/movements — generic stock operation, routed by `action`.
 *
 * Body (common): { action: 'receive'|'ship'|'adjust'|'transfer',
 *                  itemId, quantity, date?, reference? }
 *   receive : + { locationId, unitCost?, post?, offsetAccountGuid? }
 *             (unitCost + offsetAccountGuid required when post=true)
 *             → { movement, item, txnGuid }
 *   ship    : + { locationId, post? }              → { movement, item, txnGuid }
 *   adjust  : + { locationId, unitCost? } — quantity is SIGNED, never posts
 *             → { movement, item, txnGuid: null }
 *   transfer: + { fromLocationId, toLocationId }   → { outMovement, inMovement }
 */
export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    const action = body.action as string;
    const bookGuid = roleResult.bookGuid;

    if (typeof body.itemId !== 'number' || typeof body.quantity !== 'number') {
      return NextResponse.json(
        { error: 'itemId and quantity are required numbers' },
        { status: 400 },
      );
    }
    if (['receive', 'ship', 'adjust'].includes(action) && typeof body.locationId !== 'number') {
      return NextResponse.json({ error: 'locationId is a required number' }, { status: 400 });
    }
    if (
      action === 'transfer' &&
      (typeof body.fromLocationId !== 'number' || typeof body.toLocationId !== 'number')
    ) {
      return NextResponse.json(
        { error: 'fromLocationId and toLocationId are required numbers' },
        { status: 400 },
      );
    }

    if (action === 'receive') {
      const result = await receiveStock({
        bookGuid,
        itemId: body.itemId,
        locationId: body.locationId,
        quantity: body.quantity,
        unitCost: body.unitCost,
        date: body.date,
        reference: body.reference,
        post: body.post,
        offsetAccountGuid: body.offsetAccountGuid,
      });
      return NextResponse.json(result, { status: 201 });
    }
    if (action === 'ship') {
      const result = await shipStock({
        bookGuid,
        itemId: body.itemId,
        locationId: body.locationId,
        quantity: body.quantity,
        date: body.date,
        reference: body.reference,
        post: body.post,
      });
      return NextResponse.json(result, { status: 201 });
    }
    if (action === 'adjust') {
      const result = await adjustStock({
        bookGuid,
        itemId: body.itemId,
        locationId: body.locationId,
        quantity: body.quantity,
        unitCost: body.unitCost,
        date: body.date,
        reference: body.reference,
      });
      return NextResponse.json(result, { status: 201 });
    }
    if (action === 'transfer') {
      const result = await transferStock({
        bookGuid,
        itemId: body.itemId,
        fromLocationId: body.fromLocationId,
        toLocationId: body.toLocationId,
        quantity: body.quantity,
        date: body.date,
        reference: body.reference,
      });
      return NextResponse.json(result, { status: 201 });
    }

    return NextResponse.json(
      { error: `Invalid action: expected receive|ship|adjust|transfer, got '${action}'` },
      { status: 400 },
    );
  } catch (error) {
    return mapInventoryError(error);
  }
}
