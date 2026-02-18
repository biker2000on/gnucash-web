import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getIndexCoverage } from '@/lib/market-index-service';

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const coverage = await getIndexCoverage();
    return NextResponse.json(coverage);
  } catch (error) {
    console.error('Failed to get index coverage:', error);
    return NextResponse.json(
      { error: 'Failed to get index coverage' },
      { status: 500 }
    );
  }
}
