import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getPreference } from '@/lib/user-preferences';
import { getContributionLimit } from '@/lib/reports/irs-limits';
import { aggregateBookTaxData } from '@/lib/tax/book-income';
import { calculateAge } from '@/lib/reports/irs-limits';
import { FILING_STATUSES, type FilingStatus } from '@/lib/tax/types';

/**
 * GET /api/tax/estimate?year=2026
 * Aggregates book data by tax category for the requested year, plus the
 * user's tax preferences and resolved IRS contribution limits, so the
 * client-side engine can compute the full estimate transparently.
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const userId = roleResult.user.id;

    const { searchParams } = new URL(request.url);
    const yearParam = parseInt(searchParams.get('year') ?? '', 10);
    const year = Number.isFinite(yearParam) ? yearParam : new Date().getFullYear();
    if (year < 2000 || year > 2100) {
      return NextResponse.json({ error: 'Invalid year' }, { status: 400 });
    }

    const bookAccountGuids = await getBookAccountGuids();

    const [birthday, filingStatusPref, statePref, flatRatePref] = await Promise.all([
      getPreference<string | null>(userId, 'birthday', null),
      getPreference<string>(userId, 'tax_filing_status', 'single'),
      getPreference<string>(userId, 'tax_state', 'OTHER'),
      getPreference<number>(userId, 'tax_state_flat_rate', 0),
    ]);

    const filingStatus: FilingStatus = (FILING_STATUSES as readonly string[]).includes(filingStatusPref)
      ? (filingStatusPref as FilingStatus)
      : 'single';

    const bookData = await aggregateBookTaxData(bookAccountGuids, year, birthday);

    // Resolved IRS limits for scenario validation (catch-up by birthday)
    const [limit401k, limitIra, limitHsa] = await Promise.all([
      getContributionLimit(year, '401k', birthday),
      getContributionLimit(year, 'traditional_ira', birthday),
      getContributionLimit(year, 'hsa', birthday),
    ]);

    const ageAtYearEnd = birthday ? calculateAge(birthday, new Date(`${year}-12-31`)) : null;

    return NextResponse.json({
      bookData,
      preferences: {
        filingStatus,
        state: statePref || 'OTHER',
        stateFlatRate: typeof flatRatePref === 'number' ? flatRatePref : 0,
        birthday,
        ageAtYearEnd,
      },
      limits: {
        '401k': limit401k,
        ira: limitIra,
        hsa: limitHsa,
      },
    });
  } catch (error) {
    console.error('Error generating tax estimate:', error);
    return NextResponse.json({ error: 'Failed to generate tax estimate' }, { status: 500 });
  }
}
