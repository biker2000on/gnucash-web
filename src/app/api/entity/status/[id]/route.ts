// src/app/api/entity/status/[id]/route.ts
//
// PATCH  → correct an existing history row in place. This rewrites history
//          for every tax year the row covers; send { dryRun: true } first to
//          get `affectedYears` for the confirmation preview.
// DELETE → remove a row (?dryRun=1 previews). The last row cannot be removed.

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import {
  correctEntityStatusRow,
  deleteEntityStatusRow,
  EntityStatusNotFoundError,
  EntityStatusValidationError,
  parseStatusRowInput,
  todayIso,
  toRowViews,
  type MutationResult,
} from '@/lib/services/entity-status.service';

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function respond(result: MutationResult) {
  return NextResponse.json({ ...result, history: toRowViews(result.history, todayIso()) });
}

function errorResponse(error: unknown, action: string) {
  if (error instanceof EntityStatusValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof EntityStatusNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  console.error(`Error ${action} entity status row:`, error);
  return NextResponse.json({ error: `Failed ${action} entity status row` }, { status: 500 });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const id = parseId((await params).id);
    if (id === null) {
      return NextResponse.json({ error: 'Invalid status row id' }, { status: 400 });
    }

    const body = await request.json().catch(() => null);
    const input = parseStatusRowInput(body);
    const bookGuid = await getActiveBookGuid();
    return respond(
      await correctEntityStatusRow(bookGuid, id, input, {
        dryRun: (body as { dryRun?: unknown } | null)?.dryRun === true,
        userId: roleResult.user.id,
      })
    );
  } catch (error) {
    return errorResponse(error, 'correcting');
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const id = parseId((await params).id);
    if (id === null) {
      return NextResponse.json({ error: 'Invalid status row id' }, { status: 400 });
    }

    const dryRun = request.nextUrl.searchParams.get('dryRun') === '1';
    const bookGuid = await getActiveBookGuid();
    return respond(
      await deleteEntityStatusRow(bookGuid, id, { dryRun, userId: roleResult.user.id })
    );
  } catch (error) {
    return errorResponse(error, 'deleting');
  }
}
