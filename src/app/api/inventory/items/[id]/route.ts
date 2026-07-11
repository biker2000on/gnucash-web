import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getItem, updateItem, deactivateItem } from '@/lib/services/inventory.service';
import { mapInventoryError } from '@/lib/inventory-api-errors';

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * GET /api/inventory/items/[id]
 * Response: { item: InventoryItemDetail } (includes stockByLocation)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: 'Invalid item id' }, { status: 400 });

    const item = await getItem(roleResult.bookGuid, id);
    return NextResponse.json({ item });
  } catch (error) {
    return mapInventoryError(error);
  }
}

/**
 * PUT /api/inventory/items/[id] — partial update.
 * Body (all optional): { sku, name, description, unit, salePrice,
 *   incomeAccountGuid, cogsAccountGuid, assetAccountGuid, active }
 * Response: { item: InventoryItem }
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: 'Invalid item id' }, { status: 400 });

    const body = await request.json();
    const item = await updateItem(roleResult.bookGuid, id, {
      sku: body.sku,
      name: body.name,
      description: body.description,
      unit: body.unit,
      salePrice: body.salePrice,
      incomeAccountGuid: body.incomeAccountGuid,
      cogsAccountGuid: body.cogsAccountGuid,
      assetAccountGuid: body.assetAccountGuid,
      active: body.active,
    });
    return NextResponse.json({ item });
  } catch (error) {
    return mapInventoryError(error);
  }
}

/**
 * DELETE /api/inventory/items/[id] — soft delete (sets active=false).
 * Response: { item: InventoryItem }
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: 'Invalid item id' }, { status: 400 });

    const item = await deactivateItem(roleResult.bookGuid, id);
    return NextResponse.json({ item });
  } catch (error) {
    return mapInventoryError(error);
  }
}
