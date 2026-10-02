import { describe, expect, it, vi, beforeEach } from 'vitest';

const { resolvePortalToken, portalDocument, storageGet } = vi.hoisted(() => ({
  resolvePortalToken: vi.fn(),
  portalDocument: vi.fn(),
  storageGet: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: {} }));
vi.mock('@/lib/storage/storage-backend', () => ({ getStorageBackend: async () => ({ get: storageGet }) }));
vi.mock('@/lib/business/vendor-portal.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/business/vendor-portal.service')>()),
  resolvePortalToken,
  portalDocument,
}));

import {
  generatePortalToken,
  hashPortalToken,
  isLinkActive,
  methodForAccountType,
  normalizePortalExpiryDays,
  portalPath,
} from '../vendor-portal.service';
import { GET } from '@/app/api/public/vendor-portal/[token]/documents/[id]/route';

describe('vendor portal helpers', () => {
  it('generates 24-byte tokens and hashes them', () => {
    const t = generatePortalToken();
    expect(t).toMatch(/^vp_[0-9a-f]{48}$/);
    expect(generatePortalToken()).not.toBe(t);
    expect(hashPortalToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(portalPath(t)).toBe(`/share/vendor/${t}`);
  });

  it('maps account TYPES to a payer-side method, never a name', () => {
    expect(methodForAccountType('BANK')).toBe('Bank transfer or check');
    expect(methodForAccountType('CREDIT')).toBe('Card');
    expect(methodForAccountType('CASH')).toBe('Cash');
    expect(methodForAccountType('EQUITY')).toBe('Other');
    expect(methodForAccountType(undefined)).toBe('Other');
  });

  it('clamps expiry to the allowed choices', () => {
    expect(normalizePortalExpiryDays(30)).toBe(30);
    expect(normalizePortalExpiryDays('365')).toBe(365);
    expect(normalizePortalExpiryDays(9999)).toBe(180);
    expect(normalizePortalExpiryDays(undefined)).toBe(180);
  });

  it('treats revoked or expired links as inactive', () => {
    const now = new Date('2026-10-02T00:00:00Z');
    expect(isLinkActive({ revoked_at: null, expires_at: new Date('2026-10-03') }, now)).toBe(true);
    expect(isLinkActive({ revoked_at: null, expires_at: new Date('2026-10-01') }, now)).toBe(false);
    expect(isLinkActive({ revoked_at: new Date('2026-09-01'), expires_at: new Date('2027-01-01') }, now)).toBe(false);
  });
});

describe('public portal document route', () => {
  const params = (token: string, id: string) => ({ params: Promise.resolve({ token, id }) });
  const req = {} as Parameters<typeof GET>[0];

  beforeEach(() => vi.clearAllMocks());

  it('returns the same 404 for a bad token and for a document outside the scope', async () => {
    resolvePortalToken.mockResolvedValueOnce(null);
    const bad = await GET(req, params('nope', '1'));
    resolvePortalToken.mockResolvedValueOnce({ linkId: 1, bookGuid: 'b', vendorGuid: 'v', expiresAt: '' });
    portalDocument.mockResolvedValueOnce(null);
    const foreign = await GET(req, params('vp_x', '2'));
    for (const res of [bad, foreign]) {
      expect(res.status).toBe(404);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
    expect(storageGet).not.toHaveBeenCalled();
  });

  it('serves PDFs inline and anything else as a sandboxed attachment', async () => {
    resolvePortalToken.mockResolvedValue({ linkId: 1, bookGuid: 'b', vendorGuid: 'v', expiresAt: '' });
    storageGet.mockResolvedValue(Buffer.from('%PDF-1.4'));
    portalDocument.mockResolvedValueOnce({ storageKey: 'k', filename: 'remit.pdf', mimeType: 'application/pdf' });
    const pdf = await GET(req, params('vp_x', '3'));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('Content-Type')).toBe('application/pdf');
    expect(pdf.headers.get('Content-Disposition')).toBe('inline; filename="remit.pdf"');
    expect(pdf.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(pdf.headers.get('Referrer-Policy')).toBe('no-referrer');

    portalDocument.mockResolvedValueOnce({ storageKey: 'k', filename: 'evil<script>.html', mimeType: 'text/html' });
    const html = await GET(req, params('vp_x', '4'));
    expect(html.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(html.headers.get('Content-Disposition')).toBe('attachment; filename="evil_script_.html"');
  });
});
