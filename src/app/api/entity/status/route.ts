// src/app/api/entity/status/route.ts
//
// Effective-dated entity status history for the active book.
//
// GET  → { today, synthesized, history, current } plus, when asked:
//        ?asOf=YYYY-MM-DD → { asOf: { date, row, entityType } }
//        ?year=YYYY       → { taxYear: segments / mixed / year-end status }
// POST → record a change effective on a date (a new history row).
//        Body: StatusRowInput + { dryRun?: boolean }. A dry run returns the
//        tax years whose treatment would change without saving anything.

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { isIsoDate, legacyEntityType, resolveStatusAt } from '@/lib/entity-status';
import {
  EntityStatusNotFoundError,
  EntityStatusValidationError,
  listEntityStatusHistory,
  parseStatusRowInput,
  recordEntityStatusChange,
  taxYearFromRows,
  todayIso,
  toRowViews,
} from '@/lib/services/entity-status.service';

export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const bookGuid = await getActiveBookGuid();
    const today = todayIso();
    const { rows, synthesized } = await listEntityStatusHistory(bookGuid);
    const views = toRowViews(rows, today);
    const body: Record<string, unknown> = {
      today,
      synthesized,
      history: views,
      current: resolveStatusAt(views, today),
    };

    const asOf = request.nextUrl.searchParams.get('asOf');
    if (asOf !== null) {
      if (!isIsoDate(asOf)) {
        return NextResponse.json({ error: 'asOf must be YYYY-MM-DD' }, { status: 400 });
      }
      const row = resolveStatusAt(views, asOf)!;
      body.asOf = {
        date: asOf,
        row,
        entityType: legacyEntityType(row.legalForm, row.taxClassification),
      };
    }
    const yearParam = request.nextUrl.searchParams.get('year');
    if (yearParam !== null) {
      const year = Number(yearParam);
      if (!Number.isInteger(year) || year < 1900 || year > 2200) {
        return NextResponse.json({ error: 'year must be a four-digit year' }, { status: 400 });
      }
      body.taxYear = taxYearFromRows(views, year);
    }
    return NextResponse.json(body);
  } catch (error) {
    console.error('Error fetching entity status history:', error);
    return NextResponse.json({ error: 'Failed to fetch entity status history' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json().catch(() => null);
    const input = parseStatusRowInput(body);
    const bookGuid = await getActiveBookGuid();
    const result = await recordEntityStatusChange(bookGuid, input, {
      dryRun: (body as { dryRun?: unknown } | null)?.dryRun === true,
      userId: roleResult.user.id,
    });
    return NextResponse.json({ ...result, history: toRowViews(result.history, todayIso()) });
  } catch (error) {
    if (error instanceof EntityStatusValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof EntityStatusNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error('Error recording entity status change:', error);
    return NextResponse.json({ error: 'Failed to record entity status change' }, { status: 500 });
  }
}
