import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { listPayslips } from '@/lib/payslips';
import type { PayslipStatus } from '@/lib/types';

export async function GET(request: Request) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get('status');
    const status = statusParam as PayslipStatus | undefined ?? undefined;
    const employer = searchParams.get('employer') ?? undefined;

    const payslips = await listPayslips(bookGuid, { status, employer });
    return NextResponse.json(payslips);
  } catch (error) {
    console.error('Payslip list error:', error);
    return NextResponse.json({ error: 'Failed to list payslips' }, { status: 500 });
  }
}
