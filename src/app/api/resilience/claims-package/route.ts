import { NextResponse } from 'next/server';
import { zipSync, strToU8 } from 'fflate';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getStorageBackend } from '@/lib/storage/storage-backend';
import { getResilienceProfile } from '@/lib/resilience/service';
import { getEntityDocumentFile } from '@/lib/services/entity-documents.service';
import {
  getDocumentBySource,
  listLinkedDocuments,
  type CanonicalDocument,
  type LinkedDocument,
} from '@/lib/documents';
import type { InsuranceProfile } from '@/lib/resilience/types';

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '') || 'document';
}

/** Prefer file signatures so a PNG is never packaged under a .jpg name. */
export function storedFileExtension(
  bytes: Uint8Array,
  mimeType?: string | null,
  filename?: string | null,
): string {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'webp';
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.includes('png')) return 'png';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  const filenameExtension = filename?.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1];
  return filenameExtension ?? 'bin';
}

function linkedByTarget(linked: LinkedDocument[]): Map<string, LinkedDocument[]> {
  const grouped = new Map<string, LinkedDocument[]>();
  for (const item of linked) {
    const current = grouped.get(item.link.targetId) ?? [];
    current.push(item);
    grouped.set(item.link.targetId, current);
  }
  return grouped;
}

export async function GET() {
  try {
    const auth = await requireRole('readonly');
    if (auth instanceof NextResponse) return auth;
    const [profile, items] = await Promise.all([
      getResilienceProfile(auth.bookGuid, 'insurance') as Promise<InsuranceProfile>,
      prisma.gnucash_web_home_items.findMany({
        where: { book_guid: auth.bookGuid },
        include: { room: true, photos: { orderBy: { sort_order: 'asc' } } },
        orderBy: [{ room_id: 'asc' }, { name: 'asc' }],
      }),
    ]);
    const files: Record<string, Uint8Array> = {};
    const inventoryRows = [
      ['Room', 'Item', 'Category', 'Estimated replacement value', 'Serial', 'Purchase date', 'Receipt ID', 'Photo count'],
      ...items.map(item => [
        item.room.name,
        item.name || 'Unfiled item',
        item.category ?? '',
        item.est_value?.toString() ?? '',
        item.serial ?? '',
        item.purchase_date?.toISOString().slice(0, 10) ?? '',
        item.receipt_id ?? '',
        item.photos.length,
      ]),
    ];
    files['inventory.csv'] = strToU8('\uFEFF' + inventoryRows.map(row => row.map(csvCell).join(',')).join('\n'));
    files['policies.json'] = strToU8(JSON.stringify(profile.policies.map(policy => ({
      ...policy,
      policyNumber: policy.policyNumber ? `…${policy.policyNumber.slice(-4)}` : '',
    })), null, 2));
    const storage = await getStorageBackend();
    const warnings: string[] = [];
    const includedStorageKeys = new Set<string>();
    const includedSources = new Set<string>();
    const addStoredFile = async (
      storageKey: string,
      pathWithoutExtension: string,
      mimeType?: string | null,
      filename?: string | null,
    ): Promise<boolean> => {
      if (includedStorageKeys.has(storageKey)) return true;
      try {
        const buffer = await storage.get(storageKey);
        const bytes = new Uint8Array(buffer);
        const ext = storedFileExtension(bytes, mimeType, filename);
        files[`${pathWithoutExtension}.${ext}`] = bytes;
        includedStorageKeys.add(storageKey);
        return true;
      } catch {
        return false;
      }
    };

    let homeLinks: LinkedDocument[] = [];
    let entityLinks: LinkedDocument[] = [];
    try {
      [homeLinks, entityLinks] = await Promise.all([
        listLinkedDocuments({ bookGuid: auth.bookGuid, targetType: 'home_item' }),
        listLinkedDocuments({ bookGuid: auth.bookGuid, targetType: 'entity_document' }),
      ]);
    } catch {
      warnings.push('Canonical linked documents could not be enumerated.');
    }
    const homeLinksByTarget = linkedByTarget(homeLinks);
    const entityLinksByTarget = linkedByTarget(entityLinks);

    const addCanonicalDocument = async (
      document: CanonicalDocument,
      directory: string,
    ): Promise<void> => {
      if (!document.storageKey) return;
      const sourceKey = `${document.sourceKind}:${document.sourceId ?? document.id}`;
      if (includedSources.has(sourceKey) || includedStorageKeys.has(document.storageKey)) return;
      const filename = safeName(document.filename);
      const stem = filename.replace(/\.[A-Za-z0-9]{1,8}$/, '') || `document-${document.id}`;
      const added = await addStoredFile(
        document.storageKey,
        `${directory}/document-${document.id}-${stem}`,
        document.mimeType,
        document.filename,
      );
      if (added) includedSources.add(sourceKey);
      else warnings.push(`Linked document ${document.id} could not be read.`);
    };

    for (const item of items) {
      for (let index = 0; index < item.photos.length; index++) {
        const photo = item.photos[index];
        const added = await addStoredFile(
          photo.photo_key,
          `photos/item-${item.id}-${index + 1}`,
          null,
          photo.photo_key,
        );
        if (!added) {
          warnings.push(`Photo ${photo.id} for item ${item.id} could not be read.`);
        }
      }
      if (item.receipt_id) {
        const receipt = await prisma.gnucash_web_receipts.findFirst({
          where: { id: item.receipt_id, book_guid: auth.bookGuid },
        });
        if (receipt) {
          const added = await addStoredFile(
            receipt.storage_key,
            `receipts/item-${item.id}-receipt-${receipt.id}`,
            receipt.mime_type,
            receipt.filename,
          );
          if (!added) {
            warnings.push(`Receipt ${receipt.id} for item ${item.id} could not be read.`);
          }
        }
      }
      for (const linked of homeLinksByTarget.get(String(item.id)) ?? []) {
        await addCanonicalDocument(linked.document, `linked-documents/home-item-${item.id}`);
      }
    }
    // Linked policy documents from the entity document vault (book-scoped by
    // the service). Failures are non-fatal — noted in the README instead.
    const linkedDocumentIds = [...new Set(profile.policies.flatMap(policy => policy.documentIds ?? []))];
    for (const documentId of linkedDocumentIds) {
      for (const linked of entityLinksByTarget.get(String(documentId)) ?? []) {
        await addCanonicalDocument(linked.document, `policy-documents/linked-to-${documentId}`);
      }
      let canonical: CanonicalDocument | null = null;
      try {
        canonical = await getDocumentBySource(
          auth.bookGuid,
          'entity_document',
          String(documentId),
        );
      } catch {
        // Canonical metadata may be unavailable during an upgrade; the legacy
        // book-scoped vault remains a valid fallback for policy documentIds.
      }
      if (canonical?.storageKey) {
        await addCanonicalDocument(canonical, 'policy-documents');
        continue;
      }
      try {
        const file = await getEntityDocumentFile(auth.bookGuid, documentId);
        const bytes = new Uint8Array(file.buffer);
        const name = safeName(file.fileName);
        const stem = name.replace(/\.[A-Za-z0-9]{1,8}$/, '') || `document-${documentId}`;
        const ext = storedFileExtension(bytes, file.mimeType, file.fileName);
        files[`policy-documents/document-${documentId}-${stem}.${ext}`] = bytes;
      } catch {
        warnings.push(`Linked policy document ${documentId} could not be read.`);
      }
    }
    files['README.txt'] = strToU8([
      'HOME INSURANCE CLAIMS PACKAGE',
      `Generated: ${new Date().toISOString()}`,
      `Inventory items: ${items.length}`,
      `Policies: ${profile.policies.length}`,
      '',
      'Policy numbers are masked. Verify all values and coverage details before submitting a claim.',
      ...warnings.map(warning => `WARNING: ${warning}`),
    ].join('\n'));
    const zipped = zipSync(files, { level: 6 });
    return new NextResponse(Buffer.from(zipped), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="home-claims-package-${new Date().toISOString().slice(0, 10)}.zip"`,
      },
    });
  } catch (error) {
    console.error('Error generating claims package:', error);
    return NextResponse.json({ error: 'Failed to generate claims package' }, { status: 500 });
  }
}
