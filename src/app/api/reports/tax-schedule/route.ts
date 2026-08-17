import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { generateTaxSchedule } from '@/lib/tax/tax-schedule';
import { buildTxfFile, type TxfExportItem } from '@/lib/tax/txf-file';
import { saveTxfOverrides, TxfOverrideValidationError } from '@/lib/tax/txf';

/**
 * GET /api/reports/tax-schedule?year=2025&format=json|txf
 *
 * Tax Schedule Report (GnuCash desktop parity): tax-relevant accounts
 * aggregated into TXF-coded line items for the given tax year.
 *   - format=json (default): full report payload for the page.
 *   - format=txf: TXF V042 text download (tax-<year>.txf) for import into
 *     TurboTax / TaxCut / H&R Block.
 * Auth: readonly. Book-scoped.
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const yearParam = parseInt(searchParams.get('year') ?? '', 10);
    const year = Number.isFinite(yearParam) ? yearParam : new Date().getFullYear() - 1;
    if (year < 1990 || year > 2200) {
      return NextResponse.json({ error: 'Invalid year' }, { status: 400 });
    }
    const format = searchParams.get('format') ?? 'json';
    if (format !== 'json' && format !== 'txf') {
      return NextResponse.json({ error: 'Invalid format (json|txf)' }, { status: 400 });
    }

    const bookAccountGuids = await getBookAccountGuids();
    const report = await generateTaxSchedule(bookAccountGuids, year);

    if (format === 'txf') {
      const exportItems: TxfExportItem[] = report.items.map(item => ({
        code: item.code,
        payerSupported: item.payerSupported,
        total: item.total,
        accounts: item.accounts.map(a => ({ path: a.path, amount: a.amount })),
      }));
      const txf = buildTxfFile(exportItems);
      return new NextResponse(txf, {
        headers: {
          'Content-Type': 'text/plain; charset=us-ascii',
          'Content-Disposition': `attachment; filename="tax-${year}.txf"`,
        },
      });
    }

    return NextResponse.json(report);
  } catch (error) {
    console.error('Error generating tax schedule report:', error);
    return NextResponse.json(
      { error: 'Failed to generate tax schedule report' },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/reports/tax-schedule
 * Save per-account TXF code overrides used by this report and the export.
 * Body: { overrides: Array<{ accountGuid: string, code: string | null }> }
 * code null removes the override. Auth: edit. Book-scoped.
 */
export async function PUT(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    const entries: unknown = body?.overrides;
    if (!Array.isArray(entries)) {
      return NextResponse.json(
        { error: 'Body must include an "overrides" array' },
        { status: 400 },
      );
    }

    const bookAccountGuids = await getBookAccountGuids();
    try {
      await saveTxfOverrides(
        entries.map(e => ({
          accountGuid: typeof e?.accountGuid === 'string' ? e.accountGuid : '',
          code: e?.code === null ? null : typeof e?.code === 'string' ? e.code : '',
        })),
        bookAccountGuids,
      );
    } catch (err) {
      if (err instanceof TxfOverrideValidationError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    return NextResponse.json({ success: true, saved: entries.length });
  } catch (error) {
    console.error('Error saving TXF overrides:', error);
    return NextResponse.json({ error: 'Failed to save TXF overrides' }, { status: 500 });
  }
}
