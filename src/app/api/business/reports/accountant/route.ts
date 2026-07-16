// src/app/api/business/reports/accountant/route.ts
//
// Accountant workspace CSV exports: trial balance, general ledger, journal.
// Readonly role — accountants invited as readonly users can pull these
// themselves. Returns a CSV attachment.

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import {
  generateAccountantExport,
  isAccountantExportType,
  ACCOUNTANT_EXPORT_TYPES,
} from '@/lib/reports/accountant-exports';
import type { ReportFilters } from '@/lib/reports/types';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/business/reports/accountant?type=trial_balance|general_ledger|journal&startDate=&endDate=
 * -> text/csv download.
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type');
    if (!isAccountantExportType(type)) {
      return NextResponse.json(
        { error: `Invalid type — expected one of: ${ACCOUNTANT_EXPORT_TYPES.join(', ')}` },
        { status: 400 },
      );
    }
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    if ((startDate && !ISO_DATE_RE.test(startDate)) || (endDate && !ISO_DATE_RE.test(endDate))) {
      return NextResponse.json({ error: 'Dates must be YYYY-MM-DD' }, { status: 400 });
    }

    const filters: ReportFilters = {
      startDate,
      endDate,
      bookAccountGuids: await getBookAccountGuids(),
    };

    const { filename, csv } = await generateAccountantExport(type, filters);
    // BOM so Excel opens the UTF-8 CSV correctly (same as downloadCSV).
    return new Response('\ufeff' + csv + '\n', {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Error generating accountant export:', error);
    return NextResponse.json({ error: 'Failed to generate the export' }, { status: 500 });
  }
}
