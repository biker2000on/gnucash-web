import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { receiveFromBill, getBillReceiving } from '@/lib/inventory-engine';
import { mapInventoryError } from '@/lib/inventory-api-errors';

/**
 * GET /api/inventory/bills/[guid]/receiving
 * Response: { receiving: BillReceivingView }
 *   { billGuid, billId, fullyReceived,
 *     entries: [{ entryGuid, billedQuantity, unitCost, receivedQuantity,
 *                 remainingQuantity, movements: InventoryMovement[] }] }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> },
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const receiving = await getBillReceiving(roleResult.bookGuid, guid);
    return NextResponse.json({ receiving });
  } catch (error) {
    return mapInventoryError(error);
  }
}

/**
 * POST /api/inventory/bills/[guid]/receiving
 * Body: { allocations: [{ entryGuid, itemId, quantity, locationId }], date? }
 *   Receives stock against a POSTED vendor bill: 'receive' movements with
 *   unit_cost from each bill entry's price. Never writes a ledger txn —
 *   posting the bill already booked the debit (use the item's Inventory
 *   asset account on the bill line for inventory purchases).
 * Response 201: { billGuid, movements: InventoryMovement[] }
 * Errors: 400 validation/over-receive, 404 unknown bill,
 *         409 unposted bill.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const body = await request.json();
    if (!Array.isArray(body.allocations) || body.allocations.length === 0) {
      return NextResponse.json({ error: 'allocations array is required' }, { status: 400 });
    }

    const result = await receiveFromBill({
      bookGuid: roleResult.bookGuid,
      billGuid: guid,
      allocations: body.allocations,
      date: body.date,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return mapInventoryError(error);
  }
}
