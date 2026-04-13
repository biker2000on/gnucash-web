import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getPayslip } from '@/lib/payslips';
import prisma from '@/lib/prisma';

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
    const tolerance = 0.02;

    // Match transactions where a split amount matches net_pay within $0.02
    // Date range: +/- 3 days from pay_date
    // Joins splits on bank accounts, left joins transaction meta for simplefin_transaction_id
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

    return NextResponse.json({ candidates });
  } catch (error) {
    console.error('Payslip match error:', error);
    return NextResponse.json({ error: 'Failed to find matching transactions' }, { status: 500 });
  }
}
