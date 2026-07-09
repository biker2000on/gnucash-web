// src/app/api/business/taxtables/route.ts
//
// Tax table list (with entries) + create. Entry type: 'percent'
// (GNC_AMT_TYPE_PERCENT=2) or 'value' (GNC_AMT_TYPE_VALUE=1). refcount is
// recomputed from referencing customers/vendors/entries on mutations.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  listTaxtables,
  createTaxtable,
  taxtableInputSchema,
  parseInput,
  BusinessValidationError,
} from '@/lib/services/business.service';

/**
 * GET /api/business/taxtables
 * Query params: includeInvisible=true to include soft-deleted tables.
 * Each table includes its entries [{ id, account, accountName, amount, type }].
 */
export async function GET(request: Request) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const includeInvisible = searchParams.get('includeInvisible') === 'true';
    return NextResponse.json(await listTaxtables(includeInvisible));
  } catch (error) {
    console.error('Error listing tax tables:', error);
    return NextResponse.json({ error: 'Failed to list tax tables' }, { status: 500 });
  }
}

/**
 * POST /api/business/taxtables
 * Body: { name, entries: [{ account, amount, type: 'value'|'percent' }] }.
 */
export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json().catch(() => null);
    const input = parseInput(taxtableInputSchema, body);
    const taxtable = await createTaxtable(input);
    return NextResponse.json(taxtable, { status: 201 });
  } catch (error) {
    if (error instanceof BusinessValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error creating tax table:', error);
    return NextResponse.json({ error: 'Failed to create tax table' }, { status: 500 });
  }
}
