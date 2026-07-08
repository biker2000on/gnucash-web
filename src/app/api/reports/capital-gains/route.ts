import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import {
  loadCapitalGainsReport,
  loadRealizedSales,
  reconcile1099B,
  parseBrokerCSV,
  generateForm8949CSV,
  generateScheduleDCSV,
  type BrokerRow,
} from '@/lib/reports/capital-gains';

/** Default to the current calendar (tax) year. */
function currentTaxYear(): number {
  return new Date().getFullYear();
}

/**
 * GET /api/reports/capital-gains?year=2024[&format=csv&doc=8949|schedule-d]
 *
 * Returns the Form-8949 buckets + Schedule D summary as JSON, or a CSV
 * download when format=csv.
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const year = parseInt(searchParams.get('year') || '', 10) || currentTaxYear();
    const format = searchParams.get('format');
    const doc = searchParams.get('doc') || '8949';

    const bookAccountGuids = await getBookAccountGuids();
    const report = await loadCapitalGainsReport(bookAccountGuids, year);

    if (format === 'csv') {
      const isScheduleD = doc === 'schedule-d' || doc === 'scheduleD';
      const csv = isScheduleD ? generateScheduleDCSV(report) : generateForm8949CSV(report);
      const filename = isScheduleD
        ? `schedule-d-${year}.csv`
        : `form-8949-${year}.csv`;
      return new NextResponse('﻿' + csv, {
        headers: {
          'Content-Type': 'text/csv;charset=utf-8;',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    return NextResponse.json(report);
  } catch (error) {
    console.error('Error generating capital-gains report:', error);
    return NextResponse.json(
      { error: 'Failed to generate capital-gains report' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/reports/capital-gains
 * Body: { year?: number, brokerRows?: BrokerRow[], csv?: string }
 *
 * Reconciles the 1099-B rows (given directly or parsed from a pasted CSV
 * string) against the computed sales for the year. Nothing is persisted.
 */
export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json().catch(() => ({}));
    const year = parseInt(String(body?.year ?? ''), 10) || currentTaxYear();
    const brokerRows: BrokerRow[] = Array.isArray(body?.brokerRows)
      ? body.brokerRows
      : typeof body?.csv === 'string'
        ? parseBrokerCSV(body.csv)
        : [];

    const bookAccountGuids = await getBookAccountGuids();
    const sales = await loadRealizedSales(bookAccountGuids, year);
    const reconciliation = reconcile1099B(sales, brokerRows);

    return NextResponse.json({ year, ...reconciliation });
  } catch (error) {
    console.error('Error reconciling 1099-B:', error);
    return NextResponse.json(
      { error: 'Failed to reconcile 1099-B' },
      { status: 500 }
    );
  }
}
