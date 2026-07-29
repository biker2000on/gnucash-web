import { describe, expect, it } from 'vitest';
import type { EntityDocument } from '@/lib/services/entity-documents.service';
import { farmCertificateObligations } from '../farm-certificates';

function certificate(overrides: Partial<EntityDocument>): EntityDocument {
  return {
    id: 1,
    title: 'Farm certificate',
    docType: 'farm_certificate_cf',
    fileName: 'certificate.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 100,
    expiresOn: null,
    issuedOn: '2026-04-10',
    returnCopyDueOn: '2026-05-01',
    notes: null,
    uploadedAt: '2026-04-10T00:00:00.000Z',
    daysUntilExpiry: null,
    ...overrides,
  };
}

describe('farmCertificateObligations', () => {
  it('infers the conditional-certificate end date and emits return-copy work', () => {
    const obligations = farmCertificateObligations([certificate({})]);

    expect(obligations).toEqual([
      expect.objectContaining({ kind: 'return_copy', dueDate: '2026-05-01' }),
      expect.objectContaining({ kind: 'expiry', dueDate: '2028-12-31' }),
    ]);
  });

  it('ignores ordinary documents', () => {
    expect(farmCertificateObligations([
      certificate({ docType: 'insurance', expiresOn: '2026-12-31' }),
    ])).toEqual([]);
  });
});
