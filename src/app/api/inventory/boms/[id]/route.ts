import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBom, updateBom, deactivateBom } from '@/lib/services/inventory.service';
import { mapInventoryError } from '@/lib/inventory-api-errors';

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * GET /api/inventory/boms/[id]
 * Response: { bom: Bom }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: 'Invalid BOM id' }, { status: 400 });

    const bom = await getBom(roleResult.bookGuid, id);
    return NextResponse.json({ bom });
  } catch (error) {
    return mapInventoryError(error);
  }
}

/**
 * PUT /api/inventory/boms/[id] — partial update.
 * Body (all optional): { name, outputQuantity, active,
 *   lines: [{ componentItemId, quantity }] (replaces all lines) }
 * Response: { bom: Bom }
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: 'Invalid BOM id' }, { status: 400 });

    const body = await request.json();
    const bom = await updateBom(roleResult.bookGuid, id, {
      name: body.name,
      outputQuantity: body.outputQuantity,
      active: body.active,
      lines: body.lines,
    });
    return NextResponse.json({ bom });
  } catch (error) {
    return mapInventoryError(error);
  }
}

/**
 * DELETE /api/inventory/boms/[id] — soft delete (sets active=false).
 * Response: { bom: Bom }
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: 'Invalid BOM id' }, { status: 400 });

    const bom = await deactivateBom(roleResult.bookGuid, id);
    return NextResponse.json({ bom });
  } catch (error) {
    return mapInventoryError(error);
  }
}
