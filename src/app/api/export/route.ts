import { NextResponse } from 'next/server';
import { exportBookData } from '@/lib/gnucash-xml/exporter';
import { buildGnuCashXml, compressGnuCashXml } from '@/lib/gnucash-xml/builder';
import { getActiveBookRootGuid } from '@/lib/book-scope';

/**
 * GET /api/export
 *
 * Export the active book as a gzip-compressed GnuCash XML file.
 * Returns the file as an attachment download.
 */
export async function GET() {
  try {
    // Get the active book's root account
    const rootAccountGuid = await getActiveBookRootGuid();

    const data = await exportBookData(rootAccountGuid);
    const xml = buildGnuCashXml(data);
    const compressed = compressGnuCashXml(xml);

    // Generate a filename with current date
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `gnucash-export-${dateStr}.gnucash`;

    return new NextResponse(Buffer.from(compressed), {
      headers: {
        'Content-Type': 'application/x-gnucash',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(compressed.length),
      },
    });
  } catch (error) {
    console.error('Export error:', error);
    const message = error instanceof Error ? error.message : 'Export failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
