import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getPreference } from '@/lib/user-preferences';
import { getEntityProfile } from '@/lib/services/entity.service';
import { loadWithholdingCheckup } from '@/lib/withholding';
import { FILING_STATUSES, isSupportedTaxYear, type FilingStatus } from '@/lib/tax/types';

/**
 * GET /api/tools/withholding
 *
 * Query params:
 *   year                  Tax year (default: current year). Must be supported.
 *   filingStatus          single|mfj|mfs|hoh|qss (default: user preference)
 *   filersAge65Plus       0|1|2 (default 0)
 *   annualize             'false' to treat YTD as full-year (default annualize)
 *   priorYearLiability    Prior-year total federal tax (safe harbor), optional
 *   priorYearAGI          Prior-year AGI (110% high-income multiplier), optional
 *   payPeriodsPerYear     Override pay cadence (else inferred from payslips)
 *
 * Auth: readonly. Book-scoped. Returns the withholding checkup + provenance.
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const { searchParams } = new URL(request.url);

    const yearParam = parseInt(searchParams.get('year') ?? '', 10);
    const year = Number.isFinite(yearParam) ? yearParam : new Date().getFullYear();
    if (!isSupportedTaxYear(year)) {
      return NextResponse.json(
        { error: `Unsupported tax year ${year}. Supported years: 2024, 2025, 2026.` },
        { status: 400 },
      );
    }

    // A W-4 withholding checkup only makes sense for books that file a
    // personal 1040 (households and Schedule-C pass-throughs).
    const entity = await getEntityProfile(bookGuid, user.id);
    const filesPersonal1040 =
      entity.entityType === 'household' ||
      entity.entityType === 'sole_prop' ||
      entity.entityType === 'llc_single';
    if (!filesPersonal1040) {
      return NextResponse.json({
        applicable: false,
        entityType: entity.entityType,
        entityName: entity.entityName,
      });
    }

    const filingStatusPref = await getPreference<string>(user.id, 'tax_filing_status', 'single');
    const birthday = await getPreference<string | null>(user.id, 'birthday', null);

    // Book profile → user preference → default (book-scoped like the estimator)
    const filingStatusFallback = entity.filingStatus ?? filingStatusPref;
    const filingStatusParam = searchParams.get('filingStatus');
    const filingStatus: FilingStatus =
      filingStatusParam && (FILING_STATUSES as readonly string[]).includes(filingStatusParam)
        ? (filingStatusParam as FilingStatus)
        : (FILING_STATUSES as readonly string[]).includes(filingStatusFallback)
          ? (filingStatusFallback as FilingStatus)
          : 'single';

    const filersAge65Plus = Math.max(
      0,
      Math.min(2, parseInt(searchParams.get('filersAge65Plus') ?? '0', 10) || 0),
    );
    const annualize = searchParams.get('annualize') !== 'false';

    const parseMoney = (key: string): number | null => {
      const raw = searchParams.get(key);
      if (raw === null || raw === '') return null;
      const n = parseFloat(raw);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const priorYearTax = parseMoney('priorYearLiability');
    const priorYearAgi = parseMoney('priorYearAGI');

    const periodsRaw = parseInt(searchParams.get('payPeriodsPerYear') ?? '', 10);
    const payPeriodsPerYear = Number.isFinite(periodsRaw) && periodsRaw > 0 ? periodsRaw : undefined;

    const bookAccountGuids = await getBookAccountGuids();

    const payload = await loadWithholdingCheckup({
      bookAccountGuids,
      bookGuid,
      year,
      filingStatus,
      birthday: typeof birthday === 'string' ? birthday : null,
      filersAge65Plus,
      annualize,
      priorYearTax,
      priorYearAgi,
      payPeriodsPerYear,
    });

    return NextResponse.json(payload);
  } catch (error) {
    console.error('Error generating withholding checkup:', error);
    return NextResponse.json({ error: 'Failed to generate withholding checkup' }, { status: 500 });
  }
}
