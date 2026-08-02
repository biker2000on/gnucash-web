import { NextResponse } from 'next/server';
import { zipSync, strToU8 } from 'fflate';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getStorageBackend } from '@/lib/storage/storage-backend';
import { getResilienceProfile } from '@/lib/resilience/service';
import { getEntityDocumentFile } from '@/lib/services/entity-documents.service';
import type { InsuranceProfile } from '@/lib/resilience/types';

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function extension(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('webp')) return 'webp';
  return 'jpg';
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
    for (const item of items) {
      for (let index = 0; index < item.photos.length; index++) {
        const photo = item.photos[index];
        try {
          const buffer = await storage.get(photo.photo_key);
          files[`photos/item-${item.id}-${index + 1}.jpg`] = new Uint8Array(buffer);
        } catch {
          warnings.push(`Photo ${photo.id} for item ${item.id} could not be read.`);
        }
      }
      if (item.receipt_id) {
        const receipt = await prisma.gnucash_web_receipts.findFirst({
          where: { id: item.receipt_id, book_guid: auth.bookGuid },
        });
        if (receipt) {
          try {
            const buffer = await storage.get(receipt.storage_key);
            files[`receipts/item-${item.id}-receipt-${receipt.id}.${extension(receipt.mime_type)}`] = new Uint8Array(buffer);
          } catch {
            warnings.push(`Receipt ${receipt.id} for item ${item.id} could not be read.`);
          }
        }
      }
    }
    // Linked policy documents from the entity document vault (book-scoped by
    // the service). Failures are non-fatal — noted in the README instead.
    const linkedDocumentIds = [...new Set(profile.policies.flatMap(policy => policy.documentIds ?? []))];
    for (const documentId of linkedDocumentIds) {
      try {
        const file = await getEntityDocumentFile(auth.bookGuid, documentId);
        const safeName = file.fileName.replace(/[^A-Za-z0-9._-]+/g, '_');
        files[`policy-documents/document-${documentId}-${safeName}`] = new Uint8Array(file.buffer);
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
