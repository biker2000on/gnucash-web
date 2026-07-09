// src/app/api/business/billterms/route.ts
//
// Bill terms list + create. Only net-N day terms (type GNC_TERM_TYPE_DAYS)
// are supported. Unscoped like the other native business tables.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  listBillterms,
  createBillterm,
  billtermInputSchema,
  parseInput,
  BusinessValidationError,
} from '@/lib/services/business.service';

/**
 * GET /api/business/billterms
 * Query params: includeInvisible=true to include soft-deleted terms.
 */
export async function GET(request: Request) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const includeInvisible = searchParams.get('includeInvisible') === 'true';
    return NextResponse.json(await listBillterms(includeInvisible));
  } catch (error) {
    console.error('Error listing bill terms:', error);
    return NextResponse.json({ error: 'Failed to list bill terms' }, { status: 500 });
  }
}

/**
 * POST /api/business/billterms
 * Body: { name, description?, dueDays, discountDays?, discountPercent? }.
 */
export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json().catch(() => null);
    const input = parseInput(billtermInputSchema, body);
    const billterm = await createBillterm(input);
    return NextResponse.json(billterm, { status: 201 });
  } catch (error) {
    if (error instanceof BusinessValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error creating bill terms:', error);
    return NextResponse.json({ error: 'Failed to create bill terms' }, { status: 500 });
  }
}
