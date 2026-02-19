import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getAvailableTemplates } from '@/lib/account-templates';

/**
 * GET /api/books/templates
 * Returns all available account templates grouped by locale.
 * Uses requireAuth() (not requireRole()) because new users with
 * no books need to see templates during onboarding.
 */
export async function GET() {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;

  const templates = getAvailableTemplates();
  return NextResponse.json(templates);
}
