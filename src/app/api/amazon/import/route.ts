import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { AmazonImportService } from '@/lib/services/amazon-import.service';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const ALLOWED_EXTENSIONS = ['.csv', '.zip'];

export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // Validate file extension
    const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return NextResponse.json(
        { error: 'Unsupported file type. Please upload a .csv or .zip file.' },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // Validate actual buffer size
    if (buffer.byteLength > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit` },
        { status: 400 },
      );
    }

    const creditCardAccountGuid = formData.get('creditCardAccountGuid') as string | null;
    if (!creditCardAccountGuid) {
      return NextResponse.json(
        { error: 'creditCardAccountGuid is required' },
        { status: 400 },
      );
    }

    const taxMode = (formData.get('taxMode') as string) || 'separate';
    const shippingMode = (formData.get('shippingMode') as string) || 'separate';
    const taxAccountGuid = formData.get('taxAccountGuid') as string | undefined;
    const shippingAccountGuid = formData.get('shippingAccountGuid') as string | undefined;

    let descriptionPatterns: string[] | undefined;
    const patternsRaw = formData.get('descriptionPatterns') as string | null;
    if (patternsRaw) {
      try {
        descriptionPatterns = JSON.parse(patternsRaw);
      } catch {
        return NextResponse.json(
          { error: 'descriptionPatterns must be a valid JSON string array' },
          { status: 400 },
        );
      }
    }

    const result = await AmazonImportService.importFile(
      bookGuid,
      user.id,
      buffer,
      file.name,
      creditCardAccountGuid,
      {
        taxMode: taxMode as 'separate' | 'rolled_in',
        shippingMode: shippingMode as 'separate' | 'rolled_in',
        taxAccountGuid: taxAccountGuid || undefined,
        shippingAccountGuid: shippingAccountGuid || undefined,
        descriptionPatterns,
      },
    );

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error('Amazon import error:', error);
    const message = error instanceof Error ? error.message : 'Import failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
