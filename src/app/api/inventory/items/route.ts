import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { createItem, listItems } from '@/lib/services/inventory.service';
import { mapInventoryError } from '@/lib/inventory-api-errors';

/**
 * GET /api/inventory/items
 * Query params: includeInactive=true, search=<sku or name substring>
 * Response: { items: InventoryItemWithStock[] }
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const items = await listItems(roleResult.bookGuid, {
      includeInactive: searchParams.get('includeInactive') === 'true',
      search: searchParams.get('search') ?? undefined,
    });
    return NextResponse.json({ items });
  } catch (error) {
    return mapInventoryError(error);
  }
}

/**
 * POST /api/inventory/items — create an item.
 * Body: { sku, name, description?, unit?, salePrice?,
 *         incomeAccountGuid?, cogsAccountGuid?, assetAccountGuid?,
 *         valuationMethod? ('average'|'fifo'), reorderPoint?, reorderQuantity? }
 * Response 201: { item: InventoryItem }
 */
export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    if (!body.sku || !body.name) {
      return NextResponse.json({ error: 'sku and name are required' }, { status: 400 });
    }

    const item = await createItem(roleResult.bookGuid, {
      sku: body.sku,
      name: body.name,
      description: body.description,
      unit: body.unit,
      salePrice: body.salePrice,
      incomeAccountGuid: body.incomeAccountGuid,
      cogsAccountGuid: body.cogsAccountGuid,
      assetAccountGuid: body.assetAccountGuid,
      valuationMethod: body.valuationMethod,
      reorderPoint: body.reorderPoint,
      reorderQuantity: body.reorderQuantity,
    });
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return mapInventoryError(error);
  }
}
