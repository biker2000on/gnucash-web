import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getPayslip, getMappingsForEmployer } from '@/lib/payslips';
import { postPayslipTransaction } from '@/lib/services/payslip-post.service';
import type { PayslipLineItem } from '@/lib/types';

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const roleResult = await requireRole('edit');
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

    if (payslip.status === 'posted') {
      return NextResponse.json({ error: 'Payslip is already posted' }, { status: 400 });
    }

    const body = await request.json();
    const { deposit_account_guid, currency_guid, imbalance_account_guid } = body as {
      deposit_account_guid: string;
      currency_guid: string;
      imbalance_account_guid?: string;
    };

    if (!deposit_account_guid || !currency_guid) {
      return NextResponse.json(
        { error: 'deposit_account_guid and currency_guid are required' },
        { status: 400 }
      );
    }

    // Build mappings lookup: "category:normalized_label" -> account_guid
    const mappingRows = await getMappingsForEmployer(bookGuid, payslip.employer_name);
    const mappings: Record<string, string> = {};
    for (const row of mappingRows) {
      mappings[`${row.line_item_category}:${row.normalized_label}`] = row.account_guid;
    }

    // Check all non-employer-contribution items are mapped
    const lineItems = (payslip.line_items ?? []) as unknown as PayslipLineItem[];
    const unmapped = lineItems
      .filter(item => item.category !== 'employer_contribution')
      .filter(item => !mappings[`${item.category}:${item.normalized_label}`])
      .map(item => ({ category: item.category, normalized_label: item.normalized_label, label: item.label }));

    if (unmapped.length > 0) {
      return NextResponse.json({ error: 'Unmapped line items', unmapped }, { status: 400 });
    }

    const netPay = payslip.net_pay ? Number(payslip.net_pay) : 0;
    const payDate = payslip.pay_date.toISOString().slice(0, 10);

    const transactionGuid = await postPayslipTransaction(
      payslipId,
      bookGuid,
      currency_guid,
      lineItems,
      mappings,
      deposit_account_guid,
      netPay,
      payDate,
      payslip.employer_name,
      imbalance_account_guid
    );

    return NextResponse.json({ transaction_guid: transactionGuid });
  } catch (error) {
    console.error('Payslip post error:', error);
    return NextResponse.json({ error: 'Failed to post payslip' }, { status: 500 });
  }
}
