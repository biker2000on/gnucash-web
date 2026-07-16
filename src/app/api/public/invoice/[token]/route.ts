// src/app/api/public/invoice/[token]/route.ts
//
// PUBLIC (no session): resolve an invoice/estimate share token into its
// read-only snapshot. Requires the /api/public/ middleware exception
// (src/middleware.ts). Malformed, unknown, revoked, and expired tokens all
// return the same 404 so nothing about token state is leaked.

import { NextResponse } from 'next/server';
import { resolveShareToken } from '@/lib/business/invoice-shares.service';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const view = await resolveShareToken(token);
    if (!view) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(view, {
      headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
    });
  } catch (error) {
    console.error('Public invoice share error:', error);
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}
