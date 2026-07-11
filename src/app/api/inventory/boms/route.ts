import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { createBom, listBoms } from '@/lib/services/inventory.service';
import { mapInventoryError } from '@/lib/inventory-api-errors';

/**
 * GET /api/inventory/boms
 * Query params: includeInactive=true, itemId=<output item id>
 * Response: { boms: Bom[] } (each with lines)
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const boms = await listBoms(roleResult.bookGuid, {
      includeInactive: searchParams.get('includeInactive') === 'true',
      itemId: searchParams.get('itemId')
        ? parseInt(searchParams.get('itemId')!, 10)
        : undefined,
    });
    return NextResponse.json({ boms });
  } catch (error) {
    return mapInventoryError(error);
  }
}

/**
 * POST /api/inventory/boms — create a BOM.
 * Body: { itemId (output item), name, outputQuantity? (default 1),
 *         lines: [{ componentItemId, quantity }] }
 * Response 201: { bom: Bom }
 */
export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    if (typeof body.itemId !== 'number' || !body.name || !Array.isArray(body.lines)) {
      return NextResponse.json(
        { error: 'itemId, name, and a lines array are required' },
        { status: 400 },
      );
    }

    const bom = await createBom(roleResult.bookGuid, {
      itemId: body.itemId,
      name: body.name,
      outputQuantity: body.outputQuantity,
      lines: body.lines,
    });
    return NextResponse.json({ bom }, { status: 201 });
  } catch (error) {
    return mapInventoryError(error);
  }
}
