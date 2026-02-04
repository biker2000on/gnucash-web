import { NextResponse } from 'next/server';
import { isFmpConfigured } from '@/lib/config';

/**
 * GET /api/investments/status
 *
 * Returns API key configuration status for the investments module.
 *
 * @returns {Object} { configured: boolean, provider: string }
 */
export async function GET() {
  return NextResponse.json({
    configured: isFmpConfigured(),
    provider: 'Financial Modeling Prep',
  });
}
