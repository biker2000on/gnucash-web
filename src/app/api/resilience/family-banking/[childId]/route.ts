import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { calculateFamilyBanking } from '@/lib/resilience/p3-core';
import { getResolvedFamilyBankingProfile } from '@/lib/resilience/service';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ childId: string }> },
) {
  const auth = await requireRole('readonly');
  if (auth instanceof NextResponse) return auth;
  const { childId } = await params;
  // Resolved against the household roster so a linked child shows the roster
  // name and a seeded (not yet saved) ledger resolves instead of 404ing.
  const profile = await getResolvedFamilyBankingProfile(auth.bookGuid);
  const child = profile.children.find(item => item.id === childId);
  if (!child) return NextResponse.json({ error: 'Child ledger not found' }, { status: 404 });
  return NextResponse.json(calculateFamilyBanking({
    ...child,
    entries: child.entries.filter(entry => entry.approved),
  }));
}
