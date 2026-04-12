import { NextRequest, NextResponse } from 'next/server';
import { parseGnuCashXml } from '@/lib/gnucash-xml/parser';
import { importGnuCashData, BookAlreadyExistsError } from '@/lib/gnucash-xml/importer';
import type { ImportProgress } from '@/lib/gnucash-xml/importer';
import { requireRole } from '@/lib/auth';
import { grantRole } from '@/lib/services/permission.service';

/**
 * POST /api/import
 *
 * Import a GnuCash XML file (gzip or uncompressed).
 * Accepts multipart form data with a "file" field.
 * Optional "preview" field (set to "true") returns parsed counts without importing.
 *
 * When "stream" is "true", returns a text/event-stream response with
 * progress events so the UI can render a progress bar. The final event
 * carries the full import summary or an error.
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

    if (file.size > 100 * 1024 * 1024) {
      return NextResponse.json(
        { error: 'File too large. Maximum size is 100MB.' },
        { status: 400 },
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);
    const data = parseGnuCashXml(buffer);

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

    const bookName =
      file.name
        .replace(/\.(gnucash|xml|gz)$/gi, '')
        .replace(/\.(gnucash|xml)$/gi, '')
        .replace(/[_-]+/g, ' ')
        .trim() || 'Imported Book';

    const overwrite = formData.get('overwrite') === 'true';
    const stream = formData.get('stream') === 'true';

    // ── Non-streaming (legacy) path ─────────────────────────────
    if (!stream) {
      const summary = await importGnuCashData(data, bookName, { overwrite });
      if (summary.bookGuid) {
        await grantRole(roleResult.user.id, summary.bookGuid, 'admin', roleResult.user.id);
      }
      return NextResponse.json({ success: true, summary });
    }

    // ── Streaming path ──────────────────────────────────────────
    const userId = roleResult.user.id;
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        function send(event: string, payload: unknown) {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
          );
        }

        const onProgress = (p: ImportProgress) => {
          send('progress', p);
        };

        try {
          send('progress', { phase: 'Parsing XML', progress: 0 });
          const summary = await importGnuCashData(data, bookName, {
            overwrite,
            onProgress,
          });

          if (summary.bookGuid) {
            await grantRole(userId, summary.bookGuid, 'admin', userId);
          }

          send('complete', { success: true, summary });
        } catch (error) {
          if (error instanceof BookAlreadyExistsError) {
            send('error', {
              error: 'This book was already imported. Check "Overwrite existing book" and try again.',
              code: 'BOOK_EXISTS',
              bookGuid: error.bookGuid,
            });
          } else {
            console.error('Import error:', error);
            const message = error instanceof Error ? error.message : 'Import failed';
            send('error', { error: message });
          }
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    if (error instanceof BookAlreadyExistsError) {
      return NextResponse.json(
        {
          error: 'This book was already imported. Re-upload with the "overwrite existing book" option to replace it.',
          code: 'BOOK_EXISTS',
          bookGuid: error.bookGuid,
        },
        { status: 409 },
      );
    }
    console.error('Import error:', error);
    const message = error instanceof Error ? error.message : 'Import failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
