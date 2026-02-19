import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';

/**
 * GET /api/investments/status
 *
 * Returns price service configuration status.
 * Yahoo Finance requires no API key, so it is always configured.
 *
 * @returns {Object} { configured: boolean, provider: string }
 */
export async function GET() {
  const roleResult = await requireRole('readonly');
  if (roleResult instanceof NextResponse) return roleResult;

  return NextResponse.json({
    configured: true,
    provider: 'Yahoo Finance',
  });
}
