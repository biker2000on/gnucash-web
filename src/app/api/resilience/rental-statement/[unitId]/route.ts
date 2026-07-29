import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getResilienceProfile } from '@/lib/resilience/service';
import type { RentalsProfile } from '@/lib/resilience/types';

function cell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ unitId: string }> },
) {
  const auth = await requireRole('readonly');
  if (auth instanceof NextResponse) return auth;
  const profile = await getResilienceProfile(auth.bookGuid, 'rentals') as RentalsProfile;
  const unitId = (await params).unitId;
  const property = profile.properties.find(item => item.units.some(unit => unit.id === unitId));
  const unit = property?.units.find(item => item.id === unitId);
  if (!property || !unit) return NextResponse.json({ error: 'Rental unit not found' }, { status: 404 });
  const rows: unknown[][] = [
    ['Rental statement'],
    ['Property', property.name],
    ['Unit', unit.name],
    ['Tenant', unit.tenantName],
    ['Lease', `${unit.leaseStart} through ${unit.leaseEnd}`],
    ['Monthly rent', unit.monthlyRent],
    ['Security deposit held', unit.securityDeposit],
    [],
    ['Date', 'Type', 'Amount', 'Transaction GUID', 'Note'],
    ...unit.payments.slice().sort((a, b) => a.date.localeCompare(b.date)).map(payment => [
      payment.date,
      payment.kind,
      payment.amount,
      payment.transactionGuid ?? '',
      payment.note ?? '',
    ]),
  ];
  const csv = '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\n');
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="rental-statement-${unit.id}.csv"`,
    },
  });
}
