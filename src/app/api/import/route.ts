import { NextRequest, NextResponse } from 'next/server';
import { parseGnuCashXml } from '@/lib/gnucash-xml/parser';
import { importGnuCashData } from '@/lib/gnucash-xml/importer';
import { requireRole } from '@/lib/auth';

/**
 * POST /api/import
 *
 * Import a GnuCash XML file (gzip or uncompressed).
 * Accepts multipart form data with a "file" field.
 * Optional "preview" field (set to "true") returns parsed counts without importing.
 */
export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;

    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // Validate file size (max 100MB)
    if (file.size > 100 * 1024 * 1024) {
      return NextResponse.json(
        { error: 'File too large. Maximum size is 100MB.' },
        { status: 400 }
      );
    }

    // Read file as buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);

    // Parse the GnuCash XML
    const data = parseGnuCashXml(buffer);

    // Check if this is a preview request
    const preview = formData.get('preview') === 'true';
    if (preview) {
      return NextResponse.json({
        preview: true,
        counts: {
          commodities: data.commodities.length,
          accounts: data.accounts.length,
          transactions: data.transactions.length,
          splits: data.transactions.reduce((sum, tx) => sum + tx.splits.length, 0),
          prices: data.pricedb.length,
          budgets: data.budgets.length,
        },
      });
    }

    // Import the data
    const summary = await importGnuCashData(data);

    return NextResponse.json({ success: true, summary });
  } catch (error) {
    console.error('Import error:', error);
    const message = error instanceof Error ? error.message : 'Import failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
