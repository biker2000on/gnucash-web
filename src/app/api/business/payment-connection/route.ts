import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import {
  getPaymentConnectionView,
  savePaymentConnection,
} from '@/lib/business/payment-connections';
import prisma from '@/lib/prisma';

export async function GET() {
  try {
    const auth = await requireRole('admin');
    if (auth instanceof NextResponse) return auth;
    return NextResponse.json({ connection: await getPaymentConnectionView(auth.bookGuid) });
  } catch (error) {
    console.error('Error loading payment connection:', error);
    return NextResponse.json({ error: 'Failed to load payment connection' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const auth = await requireRole('admin');
    if (auth instanceof NextResponse) return auth;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: 'Request body is required' }, { status: 400 });
    const accountGuids = await getAccountGuidsForBook(auth.bookGuid);
    const transferAccountGuid = typeof body.transferAccountGuid === 'string' ? body.transferAccountGuid : null;
    const feeAccountGuid = typeof body.feeAccountGuid === 'string' ? body.feeAccountGuid : null;
    if (transferAccountGuid && !accountGuids.includes(transferAccountGuid)) {
      return NextResponse.json({ error: 'Deposit account is not in the active book' }, { status: 400 });
    }
    if (feeAccountGuid && !accountGuids.includes(feeAccountGuid)) {
      return NextResponse.json({ error: 'Fee account is not in the active book' }, { status: 400 });
    }
    const accountRows = await prisma.accounts.findMany({
      where: { guid: { in: [transferAccountGuid, feeAccountGuid].filter((guid): guid is string => Boolean(guid)) } },
      select: { guid: true, account_type: true, placeholder: true },
    });
    const byGuid = new Map(accountRows.map(account => [account.guid, account]));
    const transferAccount = transferAccountGuid ? byGuid.get(transferAccountGuid) : null;
    if (
      transferAccount
      && (transferAccount.placeholder === 1 || !['BANK', 'CASH', 'ASSET'].includes(transferAccount.account_type))
    ) {
      return NextResponse.json({ error: 'Deposit account must be a non-placeholder asset account' }, { status: 400 });
    }
    const feeAccount = feeAccountGuid ? byGuid.get(feeAccountGuid) : null;
    if (feeAccount && (feeAccount.placeholder === 1 || feeAccount.account_type !== 'EXPENSE')) {
      return NextResponse.json({ error: 'Fee account must be a non-placeholder expense account' }, { status: 400 });
    }
    const connection = await savePaymentConnection({
      bookGuid: auth.bookGuid,
      userId: auth.user.id,
      secretKey: typeof body.secretKey === 'string' ? body.secretKey : null,
      webhookSecret: typeof body.webhookSecret === 'string' ? body.webhookSecret : null,
      transferAccountGuid,
      feeAccountGuid,
      enabled: body.enabled === true,
    });
    return NextResponse.json({ connection });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save payment connection';
    console.error('Error saving payment connection:', error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
