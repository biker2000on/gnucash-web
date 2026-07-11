import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { generateStockValuationReport } from '@/lib/reports/stock-valuation';
import { mapInventoryError } from '@/lib/inventory-api-errors';

/**
 * GET /api/reports/stock-valuation
 * Current inventory valuation per item (point-in-time — no date filters):
 * qty on hand, valuation method, unit cost (avg or FIFO layer-derived),
 * extended value, per-location breakdown, and totals.
 * Response: StockValuationData
 */
export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const report = await generateStockValuationReport(roleResult.bookGuid, {
      startDate: null,
      endDate: null,
    });
    return NextResponse.json(report);
  } catch (error) {
    return mapInventoryError(error);
  }
}
