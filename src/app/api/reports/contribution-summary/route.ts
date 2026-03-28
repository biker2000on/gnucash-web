import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { generateContributionSummary } from '@/lib/reports/contribution-summary';
import { ReportFilters } from '@/lib/reports/types';

export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const bookAccountGuids = await getBookAccountGuids();

    const filters: ReportFilters = {
      startDate: searchParams.get('startDate'),
      endDate: searchParams.get('endDate'),
      bookAccountGuids,
    };

    const groupBy = (searchParams.get('groupBy') === 'tax_year' ? 'tax_year' : 'calendar_year') as 'tax_year' | 'calendar_year';
    const birthday = searchParams.get('birthday') || null;

    const report = await generateContributionSummary(filters, groupBy, birthday);

    return NextResponse.json(report);
  } catch (error) {
    console.error('Error generating contribution summary:', error);
    return NextResponse.json(
      { error: 'Failed to generate contribution summary' },
      { status: 500 }
    );
  }
}
