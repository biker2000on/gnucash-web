import { NextResponse } from 'next/server';

/**
 * GET /api/investments/status
 *
 * Returns price service configuration status.
 * Yahoo Finance requires no API key, so it is always configured.
 *
 * @returns {Object} { configured: boolean, provider: string }
 */
export async function GET() {
  return NextResponse.json({
    configured: true,
    provider: 'Yahoo Finance',
  });
}
