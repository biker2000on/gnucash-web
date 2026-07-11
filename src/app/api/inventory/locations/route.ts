import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { createLocation, listLocations } from '@/lib/services/inventory.service';
import { mapInventoryError } from '@/lib/inventory-api-errors';

/**
 * GET /api/inventory/locations
 * Query params: includeInactive=true
 * Response: { locations: InventoryLocation[] }
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const locations = await listLocations(roleResult.bookGuid, {
      includeInactive: searchParams.get('includeInactive') === 'true',
    });
    return NextResponse.json({ locations });
  } catch (error) {
    return mapInventoryError(error);
  }
}

/**
 * POST /api/inventory/locations — create a location.
 * Body: { name, description? }
 * Response 201: { location: InventoryLocation }
 */
export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    if (!body.name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    const location = await createLocation(roleResult.bookGuid, {
      name: body.name,
      description: body.description,
    });
    return NextResponse.json({ location }, { status: 201 });
  } catch (error) {
    return mapInventoryError(error);
  }
}
