import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Liveness probe AND deploy-verification endpoint.
 *
 * `revision` is the short commit the image was built from (baked in as
 * APP_REVISION by the Dockerfile). The deploy workflow polls this from
 * GitHub Actions to confirm a push actually reached production, because the
 * deploy itself runs asynchronously on the host — see
 * .github/workflows/deploy.yml. Without it a failed deploy is invisible.
 *
 * This route is in the middleware's unauthenticated allowlist (it backs the
 * container HEALTHCHECK), so only non-sensitive build metadata belongs here:
 * a short commit hash and the release version, never configuration or counts.
 */
export async function GET() {
  const revision = (process.env.APP_REVISION ?? 'unknown').slice(0, 7);
  try {
    await query('SELECT 1');
    return NextResponse.json({ status: 'ok', revision });
  } catch (error) {
    console.error('Health check failed:', error);
    return NextResponse.json({ status: 'unhealthy', revision }, { status: 503 });
  }
}
