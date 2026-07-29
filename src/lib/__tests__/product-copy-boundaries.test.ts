import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { metadata as customersMetadata } from '@/app/(main)/business/customers/page';
import { metadata as meetingsMetadata } from '@/app/(main)/business/membership/meetings/page';
import { metadata as membersMetadata } from '@/app/(main)/business/membership/page';
import { metadata as vendorsMetadata } from '@/app/(main)/business/vendors/page';
import { POST as testWebhook } from '@/app/api/settings/webhooks/[id]/test/route';
import { requireRole } from '@/lib/auth';
import { renderNotificationEmail } from '@/lib/email';
import { buildIcs } from '@/lib/ical';
import { getApiDocs } from '@/lib/swagger';
import { buildTxfFile } from '@/lib/tax/txf-file';
import { otpauthUri } from '@/lib/totp';
import { deliverToWebhook, getWebhook } from '@/lib/webhooks';

vi.mock('@/lib/auth', () => ({ requireRole: vi.fn() }));
vi.mock('@/lib/webhooks', () => ({
  deliverToWebhook: vi.fn(),
  getWebhook: vi.fn(),
}));

describe('Folio product copy boundaries', () => {
  it('uses the Folio brand for user-visible secondary exports and metadata', () => {
    expect(otpauthUri('secret', 'alice')).toContain('issuer=Folio');

    expect(renderNotificationEmail({
      title: 'Ready',
      message: null,
      href: null,
      severity: 'success',
      type: 'report',
    }).subject).toBe('[Folio] Ready');

    const calendar = buildIcs([]);
    expect(calendar).toContain('PRODID:-//Folio//Calendar Feed//EN');
    expect(calendar).toContain('X-WR-CALNAME:Folio');

    expect(buildTxfFile([], { date: new Date(2026, 3, 15) }))
      .toContain('AFolio\r\n');

    const apiDocs = getApiDocs() as { info?: { title?: string; description?: string } };
    expect(apiDocs.info).toMatchObject({
      title: 'Folio API',
      description: 'A self-hosted personal and small-business finance platform.',
    });
  });

  it('keeps stable GnuCash compatibility identifiers unchanged', () => {
    expect(readFileSync('src/lib/ical.ts', 'utf8'))
      .toContain('PRODID:-//Folio//Calendar Feed//EN');
    expect(readFileSync('src/lib/business/stripe-webhook.ts', 'utf8'))
      .toContain('gnucash-web/payment-event');
  });

  it('uses the Folio brand in secondary business page metadata', () => {
    expect([
      vendorsMetadata.title,
      customersMetadata.title,
      membersMetadata.title,
      meetingsMetadata.title,
    ]).toEqual([
      'Vendors - Folio',
      'Customers - Folio',
      'Members - Folio',
      'Meetings - Folio',
    ]);
  });

  it('uses the Folio brand in webhook test events', async () => {
    vi.mocked(requireRole).mockResolvedValue({
      viaToken: false,
      user: { id: 17 },
      bookGuid: 'default-book',
    } as never);
    vi.mocked(getWebhook).mockResolvedValue({ bookGuid: 'webhook-book' } as never);
    vi.mocked(deliverToWebhook).mockResolvedValue('204');

    const response = await testWebhook(null as never, {
      params: Promise.resolve({ id: '42' }),
    });

    expect(response.status).toBe(200);
    expect(deliverToWebhook).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'webhook_test',
        title: 'Test event from Folio',
      }),
    );
  });
});
