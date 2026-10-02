// src/app/api/public/vendor-portal/[token]/documents/[id]/route.ts
//
// Public (no session — /api/public is exempt in middleware) download of a
// remittance/receipt document from a contractor portal link. The document
// must be linked to one of THIS link's vendor's payment transactions in
// THIS book; every other case, including a bad token, is the same 404.

import { NextRequest, NextResponse } from 'next/server';
import { portalDocument, resolvePortalToken } from '@/lib/business/vendor-portal.service';
import { getStorageBackend } from '@/lib/storage/storage-backend';

type Params = { params: Promise<{ token: string; id: string }> };

const NOT_FOUND = () =>
  NextResponse.json(
    { error: 'Not found' },
    { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } },
  );

/** Only types a browser can show inline safely; everything else downloads. */
const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { token, id } = await params;
    const resolved = await resolvePortalToken(token);
    if (!resolved) return NOT_FOUND();
    const doc = await portalDocument(resolved, Number(id));
    if (!doc) return NOT_FOUND();
    const bytes = await (await getStorageBackend()).get(doc.storageKey);
    const mime = doc.mimeType && INLINE_TYPES.has(doc.mimeType) ? doc.mimeType : 'application/octet-stream';
    const safeName = doc.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'document';
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Disposition': `${mime === 'application/octet-stream' ? 'attachment' : 'inline'}; filename="${safeName}"`,
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    console.error('Vendor portal document failed:', error);
    return NOT_FOUND();
  }
}
