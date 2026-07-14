// src/app/api/business/packages/route.ts
//
// Prepaid packages (deferred revenue): list + sell. Book-scoped.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { mapPackageError } from '@/lib/business/api-errors';
import { listPackages, sellPackage } from '@/lib/services/packages.service';

/** GET /api/business/packages — all packages in the active book. */
export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const bookGuid = await getActiveBookGuid();
    return NextResponse.json(await listPackages(bookGuid));
  } catch (error) {
    return mapPackageError(error);
  }
}

/**
 * POST /api/business/packages — sell a package.
 * Body: { name, clientName?, customerGuid?, sessionsTotal, price, soldDate,
 *         bankAccountGuid, liabilityAccountGuid?, incomeAccountGuid?, notes? }.
 * Creates the bank → unearned-revenue sale transaction.
 */
export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const bookGuid = await getActiveBookGuid();
    const pkg = await sellPackage(bookGuid, body);
    return NextResponse.json(pkg, { status: 201 });
  } catch (error) {
    return mapPackageError(error);
  }
}
