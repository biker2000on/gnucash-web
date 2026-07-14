import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { getEntityProfile } from '@/lib/services/entity.service';
import {
  complianceItemsForYear,
  complianceStatusKey,
  type ComplianceItemWithStatus,
} from '@/lib/compliance';

/** Days of lookahead into year+1 when no explicit year is requested. */
const LOOKAHEAD_DAYS = 92;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * GET /api/compliance?year=2026
 *
 * Compliance deadlines for the active book's entity type + tax state,
 * merged with persisted done/dismissed statuses. Without an explicit
 * `year`, returns the current year's items plus a ~3-month lookahead into
 * next year (so January deadlines surface from October onward).
 *
 * Auth: readonly.
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const { searchParams } = new URL(request.url);
    const yearParam = parseInt(searchParams.get('year') ?? '', 10);
    const explicitYear = Number.isFinite(yearParam) ? yearParam : null;
    if (explicitYear !== null && (explicitYear < 2000 || explicitYear > 2100)) {
      return NextResponse.json({ error: 'Invalid year' }, { status: 400 });
    }

    const now = new Date();
    const year = explicitYear ?? now.getFullYear();

    const entity = await getEntityProfile(bookGuid, user.id);

    const items = complianceItemsForYear(entity.entityType, entity.taxState, year);
    if (explicitYear === null) {
      // Lookahead: next year's items due within ~3 months from today.
      const horizon = isoDate(new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000));
      const nextYearItems = complianceItemsForYear(
        entity.entityType,
        entity.taxState,
        year + 1,
      ).filter(i => i.dueDate <= horizon);
      items.push(...nextYearItems);
    }

    const statusRows = await prisma.gnucash_web_compliance_status.findMany({
      where: { book_guid: bookGuid },
    });
    const statusMap = new Map(
      statusRows.map(r => [complianceStatusKey(r.item_key, r.period), r]),
    );

    const merged: ComplianceItemWithStatus[] = items
      .map(i => {
        const row = statusMap.get(complianceStatusKey(i.key, i.period));
        return {
          ...i,
          status: row ? (row.status === 'dismissed' ? 'dismissed' as const : 'done' as const) : 'pending' as const,
          completedAt: row ? row.completed_at.toISOString() : null,
        };
      })
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.key.localeCompare(b.key));

    return NextResponse.json({
      year,
      today: isoDate(now),
      entity: {
        entityType: entity.entityType,
        entityName: entity.entityName,
        taxState: entity.taxState,
      },
      items: merged,
    });
  } catch (error) {
    console.error('Error loading compliance calendar:', error);
    return NextResponse.json({ error: 'Failed to load compliance calendar' }, { status: 500 });
  }
}

/**
 * PUT /api/compliance
 *
 * Body: { itemKey: string, period: string, status: 'done' | 'dismissed' | null }
 * null clears the status back to pending. Auth: edit.
 */
export async function PUT(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const body = await request.json().catch(() => null) as {
      itemKey?: unknown; period?: unknown; status?: unknown;
    } | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const itemKey = typeof body.itemKey === 'string' ? body.itemKey.trim() : '';
    const period = typeof body.period === 'string' ? body.period.trim() : '';
    const status = body.status;

    if (!itemKey || itemKey.length > 80 || !period || period.length > 20) {
      return NextResponse.json({ error: 'itemKey and period are required' }, { status: 400 });
    }
    if (status !== 'done' && status !== 'dismissed' && status !== null) {
      return NextResponse.json(
        { error: "status must be 'done', 'dismissed', or null" },
        { status: 400 },
      );
    }

    if (status === null) {
      await prisma.gnucash_web_compliance_status.deleteMany({
        where: { book_guid: bookGuid, item_key: itemKey, period },
      });
      return NextResponse.json({ ok: true, status: 'pending' });
    }

    await prisma.gnucash_web_compliance_status.upsert({
      where: {
        book_guid_item_key_period: {
          book_guid: bookGuid,
          item_key: itemKey,
          period,
        },
      },
      create: { book_guid: bookGuid, item_key: itemKey, period, status },
      update: { status, completed_at: new Date() },
    });

    return NextResponse.json({ ok: true, status });
  } catch (error) {
    console.error('Error updating compliance status:', error);
    return NextResponse.json({ error: 'Failed to update compliance status' }, { status: 500 });
  }
}
