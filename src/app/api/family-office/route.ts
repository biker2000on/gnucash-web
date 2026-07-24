import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  approveInterbookElimination,
  findInterbookTransferCandidates,
  getFamilyActionCounts,
  getFamilyOfficeSummary,
  getFamilyTimeline,
  searchFamilyDocuments,
} from '@/lib/family-office/service';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireRole('readonly');
    if (auth instanceof NextResponse) return auth;
    const q = request.nextUrl.searchParams.get('q')?.trim() ?? '';
    const includeTimeline = request.nextUrl.searchParams.get('timeline') !== 'false';
    const [summary, transfers, documents, actionCounts, timeline] = await Promise.all([
      getFamilyOfficeSummary(auth.user.id, auth.bookGuid),
      findInterbookTransferCandidates(auth.user.id, auth.bookGuid),
      searchFamilyDocuments(auth.user.id, auth.bookGuid, q),
      getFamilyActionCounts(auth.user.id, auth.bookGuid),
      includeTimeline
        ? getFamilyTimeline(auth.user.id, auth.bookGuid)
        : Promise.resolve({ events: [], conflicts: [] }),
    ]);
    return NextResponse.json({ summary, transfers, documents, actionCounts, timeline });
  } catch (error) {
    console.error('Error loading Family Office:', error);
    return NextResponse.json({ error: 'Failed to load Family Office' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole('edit');
    if (auth instanceof NextResponse) return auth;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (body?.action !== 'approve_elimination' || typeof body.candidateId !== 'string') {
      return NextResponse.json({ error: 'approve_elimination requires candidateId' }, { status: 400 });
    }
    const candidate = await approveInterbookElimination(
      auth.user.id,
      auth.bookGuid,
      body.candidateId,
    );
    return NextResponse.json({ candidate });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to approve elimination';
    console.error('Error approving inter-book elimination:', error);
    const expected = message === 'Transfer candidate not found in the authorized family graph';
    return NextResponse.json(
      { error: expected ? message : 'Failed to approve elimination' },
      { status: expected ? 400 : 500 },
    );
  }
}
