import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getPayslip, getMappingsForEmployer } from '@/lib/payslips';
import { buildSplitsFromLineItems } from '@/lib/payslip-splits';
import { findMatchingTransaction } from '@/lib/services/payslip-post.service';
import prisma from '@/lib/prisma';
import type { PayslipLineItem } from '@/lib/types';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { id } = await params;
    const payslipId = parseInt(id, 10);
    if (isNaN(payslipId)) {
      return NextResponse.json({ error: 'Invalid payslip ID' }, { status: 400 });
    }

    const payslip = await getPayslip(payslipId, bookGuid);
    if (!payslip) {
      return NextResponse.json({ error: 'Payslip not found' }, { status: 404 });
    }

    const netPay = payslip.net_pay ? Number(payslip.net_pay) : 0;
    const payDate = payslip.pay_date;
    const lineItems = (payslip.line_items ?? []) as unknown as PayslipLineItem[];

    // --- Full-split dedup check ---
    // If line items exist and are mapped, check for an existing transaction
    // with all the same splits (same accounts, amounts within $0.01)
    let exactMatch: string | null = null;
    if (lineItems.length > 0) {
      const mappingRows = await getMappingsForEmployer(bookGuid, payslip.employer_name);
      const mappings: Record<string, string> = {};
      for (const row of mappingRows) {
        mappings[`${row.line_item_category}:${row.normalized_label}`] = row.account_guid;
      }

      // Check if we have a deposit account to build full splits
      const url = new URL(request.url);
      const depositAccountGuid = url.searchParams.get('deposit_account_guid');

      if (depositAccountGuid) {
        const splits = buildSplitsFromLineItems(lineItems, mappings, depositAccountGuid, netPay);
        const payDateStr = payDate.toISOString().slice(0, 10);
        exactMatch = await findMatchingTransaction(splits, payDateStr);
      }
    }

    // --- Net-pay lump-sum match (SimpleFin deposits) ---
    const tolerance = 0.02;
    const candidates = await prisma.$queryRaw<
      Array<{
        transaction_guid: string;
        description: string;
        post_date: Date;
        split_guid: string;
        split_amount: number;
        account_guid: string;
        account_name: string;
        simplefin_transaction_id: string | null;
      }>
    >`
      SELECT
        t.guid AS transaction_guid,
        t.description,
        t.post_date,
        s.guid AS split_guid,
        (s.value_num::float / s.value_denom::float) AS split_amount,
        s.account_guid,
        a.name AS account_name,
        m.simplefin_transaction_id
      FROM transactions t
      JOIN splits s ON s.tx_guid = t.guid
      JOIN accounts a ON a.guid = s.account_guid
      LEFT JOIN gnucash_web_transaction_meta m ON m.transaction_guid = t.guid
      WHERE a.account_type IN ('BANK', 'CREDIT_CARD')
        AND ABS((s.value_num::float / s.value_denom::float) - ${netPay}) <= ${tolerance}
        AND t.post_date BETWEEN ${new Date(payDate.getTime() - 3 * 24 * 60 * 60 * 1000)} AND ${new Date(payDate.getTime() + 3 * 24 * 60 * 60 * 1000)}
      ORDER BY ABS(EXTRACT(EPOCH FROM (t.post_date - ${payDate}::timestamptz)))
      LIMIT 10
    `;

    return NextResponse.json({
      exact_match: exactMatch,
      candidates,
    });
  } catch (error) {
    console.error('Payslip match error:', error);
    return NextResponse.json({ error: 'Failed to find matching transactions' }, { status: 500 });
  }
}
