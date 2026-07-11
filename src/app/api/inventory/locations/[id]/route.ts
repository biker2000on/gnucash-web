import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { updateLocation, deactivateLocation } from '@/lib/services/inventory.service';
import { mapInventoryError } from '@/lib/inventory-api-errors';

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * PUT /api/inventory/locations/[id] — partial update.
 * Body (all optional): { name, description, active }
 * Response: { location: InventoryLocation }
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: 'Invalid location id' }, { status: 400 });

    const body = await request.json();
    const location = await updateLocation(roleResult.bookGuid, id, {
      name: body.name,
      description: body.description,
      active: body.active,
    });
    return NextResponse.json({ location });
  } catch (error) {
    return mapInventoryError(error);
  }
}

/**
 * DELETE /api/inventory/locations/[id] — soft delete (sets active=false).
 * Response: { location: InventoryLocation }
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: 'Invalid location id' }, { status: 400 });

    const location = await deactivateLocation(roleResult.bookGuid, id);
    return NextResponse.json({ location });
  } catch (error) {
    return mapInventoryError(error);
  }
}
