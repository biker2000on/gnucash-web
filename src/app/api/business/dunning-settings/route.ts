// src/app/api/business/dunning-settings/route.ts
//
// Per-book dunning (payment reminder) settings: enable flag, days-overdue
// schedule, and email subject/body templates.

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { getDunningSettings, saveDunningSettings } from '@/lib/business/dunning';

/** GET /api/business/dunning-settings — settings (defaults when unset). */
export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const bookGuid = await getActiveBookGuid();
    const settings = await getDunningSettings(bookGuid);
    return NextResponse.json({ settings });
  } catch (error) {
    console.error('Error loading dunning settings:', error);
    return NextResponse.json({ error: 'Failed to load dunning settings' }, { status: 500 });
  }
}

/**
 * PUT /api/business/dunning-settings — upsert settings.
 * Body: { enabled?, schedule?: number[], emailSubject?, emailBody? }
 */
export async function PUT(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const bookGuid = await getActiveBookGuid();
    const settings = await saveDunningSettings(bookGuid, {
      enabled: body.enabled,
      schedule: body.schedule,
      emailSubject: body.emailSubject,
      emailBody: body.emailBody,
    });
    return NextResponse.json({ settings });
  } catch (error) {
    console.error('Error saving dunning settings:', error);
    return NextResponse.json({ error: 'Failed to save dunning settings' }, { status: 500 });
  }
}
