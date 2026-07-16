import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { listReceipts } from '@/lib/receipts';
import { computeShoeboxSummary, type ShoeboxReceiptLike } from '@/lib/hsa-shoebox';
import {
  getHsaAccounts,
  reimburseReceipts,
  ReimburseError,
} from '@/lib/services/hsa-shoebox.service';

const MAX_RECEIPTS = 500;

interface ShoeboxReceipt {
  id: number;
  filename: string;
  createdAt: string;
  /** Extracted receipt date (falls back to null; UI falls back to createdAt). */
  date: string | null;
  merchant: string | null;
  amount: number | null;
  transactionGuid: string | null;
  transactionDescription: string | null;
  reimbursedTxnGuid: string | null;
}

/**
 * GET /api/tools/hsa-shoebox
 *
 * Shoebox summary for the active book: every HSA-eligible receipt (with
 * extracted merchant/date/amount), the flagged HSA accounts with current
 * balances, and the eligible/unreimbursed/headroom math.
 */
export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const bookAccountGuids = await getBookAccountGuids();

    const [{ receipts }, hsaAccounts] = await Promise.all([
      listReceipts({ bookGuid, limit: MAX_RECEIPTS, offset: 0, hsaEligible: true }),
      getHsaAccounts(bookAccountGuids),
    ]);

    const shaped: ShoeboxReceipt[] = receipts.map(r => {
      const data = (r.extracted_data ?? null) as Record<string, unknown> | null;
      const amount = data && typeof data.amount === 'number' && Number.isFinite(data.amount)
        ? data.amount
        : null;
      return {
        id: r.id,
        filename: r.filename,
        createdAt: r.created_at,
        date: data && typeof data.date === 'string' ? data.date : null,
        merchant: data && typeof data.vendor === 'string' ? data.vendor : null,
        amount,
        transactionGuid: r.transaction_guid,
        transactionDescription: r.transaction_description ?? null,
        reimbursedTxnGuid: r.hsa_reimbursed_txn_guid,
      };
    });

    const summaryInput: ShoeboxReceiptLike[] = shaped.map(r => ({
      amount: r.amount,
      hsaEligible: true,
      reimbursed: r.reimbursedTxnGuid !== null,
    }));
    const totalHsaBalance = hsaAccounts.reduce((s, a) => s + a.balance, 0);
    const summary = computeShoeboxSummary(summaryInput, totalHsaBalance);

    return NextResponse.json({
      summary,
      receipts: shaped,
      hsaAccounts,
      hsaAccountsFlagged: hsaAccounts.length > 0,
    });
  } catch (error) {
    console.error('HSA shoebox summary error:', error);
    return NextResponse.json({ error: 'Failed to load HSA shoebox' }, { status: 500 });
  }
}

/**
 * POST /api/tools/hsa-shoebox
 *
 * Reimburse a set of eligible, unreimbursed receipts: creates one GnuCash
 * transaction (debit bank, credit HSA) and stamps each receipt with the
 * transaction guid.
 *
 * Body: { receiptIds: number[], bankAccountGuid, hsaAccountGuid, date }
 */
export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { receiptIds, bankAccountGuid, hsaAccountGuid, date } = body as Record<string, unknown>;

    if (!Array.isArray(receiptIds) || receiptIds.length === 0) {
      return NextResponse.json({ error: 'receiptIds is required' }, { status: 400 });
    }
    if (typeof bankAccountGuid !== 'string' || typeof hsaAccountGuid !== 'string') {
      return NextResponse.json(
        { error: 'bankAccountGuid and hsaAccountGuid are required' },
        { status: 400 },
      );
    }
    const dateStr =
      typeof date === 'string' && date ? date : new Date().toISOString().slice(0, 10);

    const bookAccountGuids = await getBookAccountGuids();
    const result = await reimburseReceipts({
      bookGuid,
      bookAccountGuids,
      receiptIds: receiptIds.map(id => Number(id)),
      bankAccountGuid,
      hsaAccountGuid,
      date: dateStr,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ReimburseError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('HSA reimbursement error:', error);
    return NextResponse.json({ error: 'Failed to post reimbursement' }, { status: 500 });
  }
}
