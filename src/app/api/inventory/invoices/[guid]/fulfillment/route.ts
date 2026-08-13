import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  fulfillInvoiceLines,
  returnToStock,
  getInvoiceFulfillment,
} from '@/lib/inventory-engine';
import { mapInventoryError } from '@/lib/inventory-api-errors';
import { afterLedgerWrite } from '@/lib/data-events';

/**
 * GET /api/inventory/invoices/[guid]/fulfillment
 * Response: { fulfillment: InvoiceFulfillmentView }
 *   { invoiceGuid, invoiceId, fullyFulfilled,
 *     entries: [{ entryGuid, invoicedQuantity, fulfilledQuantity,
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
    const fulfillment = await getInvoiceFulfillment(roleResult.bookGuid, guid);
    return NextResponse.json({ fulfillment });
  } catch (error) {
    return mapInventoryError(error);
  }
}

/**
 * POST /api/inventory/invoices/[guid]/fulfillment
 * Body: { mode?: 'fulfill' (default) | 'return',
 *         allocations: [{ entryGuid, itemId, quantity, locationId }],
 *         date?, post? }
 *   post DEFAULTS TO TRUE: omitting it writes the COGS entry. Send the boolean
 *   `false` to opt out (leaving inventory relieved with no cost recognized).
 *   mode 'fulfill': ship stock against a POSTED customer invoice
 *     (writes a COGS txn per allocation).
 *   mode 'return' : return previously fulfilled quantities to stock
 *     (writes a reversing COGS txn per allocation).
 * Response 201: { invoiceGuid, movements: InventoryMovement[] }
 * Errors: 400 validation/over-fulfillment, 404 unknown invoice,
 *         409 unposted invoice or insufficient stock.
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
    const mode = body.mode ?? 'fulfill';
    if (!['fulfill', 'return'].includes(mode)) {
      return NextResponse.json(
        { error: `Invalid mode: expected 'fulfill' or 'return', got '${mode}'` },
        { status: 400 },
      );
    }
    if (!Array.isArray(body.allocations) || body.allocations.length === 0) {
      return NextResponse.json({ error: 'allocations array is required' }, { status: 400 });
    }

    const input = {
      bookGuid: roleResult.bookGuid,
      invoiceGuid: guid,
      allocations: body.allocations,
      date: body.date,
      // Only an explicit boolean speaks: anything else (absent, null, a
      // stray string) falls through to the engine's post-by-default.
      post: typeof body.post === 'boolean' ? body.post : undefined,
    };
    const result = mode === 'return'
      ? await returnToStock(input)
      : await fulfillInvoiceLines(input);
    afterLedgerWrite(roleResult.bookGuid, 'transactions', { action: 'create' });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return mapInventoryError(error);
  }
}
