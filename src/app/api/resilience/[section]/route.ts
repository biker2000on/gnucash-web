import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  getResilienceSection,
  ResilienceValidationError,
  saveResilienceProfile,
} from '@/lib/resilience/service';
import type { ResilienceSection } from '@/lib/resilience/types';

const SECTIONS = new Set<ResilienceSection>([
  'rentals',
  'insurance',
  'capital',
  'life',
  'healthcare',
  'mileage',
  'fuel',
]);

function sectionFrom(value: string): ResilienceSection | null {
  return SECTIONS.has(value as ResilienceSection) ? value as ResilienceSection : null;
}
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ section: string }> },
) {
  try {
    const auth = await requireRole('readonly');
    if (auth instanceof NextResponse) return auth;
    const section = sectionFrom((await params).section);
    if (!section) return NextResponse.json({ error: 'Unknown resilience section' }, { status: 404 });
    return NextResponse.json(await getResilienceSection(auth.bookGuid, section));
  } catch (error) {
    console.error('Error loading resilience section:', error);
    return NextResponse.json({ error: 'Failed to load resilience data' }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ section: string }> },
) {
  try {
    const auth = await requireRole('edit');
    if (auth instanceof NextResponse) return auth;
    const section = sectionFrom((await params).section);
    if (!section) return NextResponse.json({ error: 'Unknown resilience section' }, { status: 404 });
    const body = await request.json().catch(() => null) as {
      profile?: unknown;
      token?: string | null;
    } | null;
    if (!body || body.profile == null) {
      return NextResponse.json({ error: 'profile is required' }, { status: 400 });
    }
    await saveResilienceProfile({
      bookGuid: auth.bookGuid,
      userId: auth.user.id,
      section,
      data: body.profile,
      token: body.token,
    });
    return NextResponse.json(await getResilienceSection(auth.bookGuid, section));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save resilience data';
    if (error instanceof ResilienceValidationError) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    console.error('Error saving resilience section:', error);
    return NextResponse.json({ error: 'Failed to save resilience data' }, { status: 500 });
  }
}
