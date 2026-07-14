import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getEntityProfile } from '@/lib/services/entity.service';

/** Gross-receipts ceiling for Form 990-N (e-Postcard) eligibility. */
const FORM_990N_THRESHOLD = 50_000;

/**
 * GET /api/business/990?year=2025
 *
 * Form 990-N helper for a 501(c)(3) book: gross receipts for a calendar
 * fiscal year (total INCOME-account activity, sign-corrected positive), the
 * $50k e-Postcard eligibility test, due date, and prefillable e-postcard
 * checklist fields. Defaults to the most recently COMPLETED fiscal year.
 * Non-nonprofit books get { applicable: false }.
 *
 * Auth: readonly.
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const { searchParams } = new URL(request.url);
    const yearParam = parseInt(searchParams.get('year') ?? '', 10);
    const year = Number.isFinite(yearParam) ? yearParam : new Date().getFullYear() - 1;
    if (year < 2000 || year > 2100) {
      return NextResponse.json({ error: 'Invalid year' }, { status: 400 });
    }

    const entity = await getEntityProfile(bookGuid, user.id);
    if (entity.entityType !== 'nonprofit_501c3') {
      return NextResponse.json({ applicable: false, entityType: entity.entityType });
    }

    /* --- Gross receipts: all INCOME-account activity in the FY --------- */
    const bookAccountGuids = await getBookAccountGuids();
    const startDate = new Date(Date.UTC(year, 0, 1));
    const endDate = new Date(Date.UTC(year, 11, 31, 23, 59, 59));

    const rows = await prisma.$queryRaw<Array<{ total: number | null }>>`
      SELECT (-SUM(s.value_num::numeric / s.value_denom))::float8 AS total
      FROM splits s
      JOIN transactions t ON s.tx_guid = t.guid
      JOIN accounts a ON s.account_guid = a.guid
      WHERE s.account_guid = ANY(${bookAccountGuids})
        AND a.account_type = 'INCOME'
        AND t.post_date >= ${startDate}
        AND t.post_date <= ${endDate}
    `;
    // GnuCash stores income as credits (negative) — negated in SQL above.
    const grossReceipts = Math.round((rows[0]?.total ?? 0) * 100) / 100;
    const qualifiesFor990N = grossReceipts <= FORM_990N_THRESHOLD;

    const officer = entity.members.find(m => m.role === 'officer') ?? null;

    return NextResponse.json({
      applicable: true,
      year,
      fiscalYearStart: `${year}-01-01`,
      fiscalYearEnd: `${year}-12-31`,
      grossReceipts,
      threshold: FORM_990N_THRESHOLD,
      qualifiesFor990N,
      /** 15th day of the 5th month after calendar FY end. */
      dueDate: `${year + 1}-05-15`,
      checklist: {
        /** Not stored — the page tells the user to have the EIN letter ready. */
        ein: null,
        taxYear: year,
        legalName: entity.entityName,
        mailingAddress: null,
        otherNames: null,
        principalOfficer: officer?.name ?? null,
        website: null,
        grossReceiptsUnder50k: qualifiesFor990N,
        terminated: false,
      },
    });
  } catch (error) {
    console.error('Error generating 990-N helper:', error);
    return NextResponse.json({ error: 'Failed to generate 990-N data' }, { status: 500 });
  }
}
