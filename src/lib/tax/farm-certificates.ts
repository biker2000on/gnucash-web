import {
  listEntityDocuments,
  type EntityDocument,
} from '@/lib/services/entity-documents.service';

export interface FarmCertificateObligation {
  key: string;
  documentId: number;
  certificateType: 'E-595QF' | 'E-595CF';
  kind: 'expiry' | 'return_copy';
  title: string;
  description: string;
  dueDate: string;
}

export function farmCertificateObligations(
  documents: EntityDocument[],
): FarmCertificateObligation[] {
  return documents.flatMap((document) => {
    const certificateType =
      document.docType === 'farm_certificate_qf'
        ? 'E-595QF'
        : document.docType === 'farm_certificate_cf'
          ? 'E-595CF'
          : null;
    if (!certificateType) return [];

    const obligations: FarmCertificateObligation[] = [];
    const inferredConditionalExpiry =
      certificateType === 'E-595CF' && document.issuedOn
        ? `${Number(document.issuedOn.slice(0, 4)) + 2}-12-31`
        : null;
    const expiry = document.expiresOn ?? inferredConditionalExpiry;
    if (expiry) {
      obligations.push({
        key: `farm-certificate:${document.id}:expiry`,
        documentId: document.id,
        certificateType,
        kind: 'expiry',
        title: `${certificateType} certificate expires`,
        description: `Review eligibility and renew or close out “${document.title}” before the certificate expires.`,
        dueDate: expiry,
      });
    }
    if (document.returnCopyDueOn) {
      obligations.push({
        key: `farm-certificate:${document.id}:return-copy`,
        documentId: document.id,
        certificateType,
        kind: 'return_copy',
        title: `${certificateType} return-copy obligation`,
        description: `Return the required certificate copy for “${document.title}” by this date.`,
        dueDate: document.returnCopyDueOn,
      });
    }
    return obligations;
  }).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.key.localeCompare(b.key));
}

export async function getFarmCertificateObligations(
  bookGuid: string,
): Promise<FarmCertificateObligation[]> {
  return farmCertificateObligations(await listEntityDocuments(bookGuid));
}
