import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getPreference } from '@/lib/user-preferences';
import { getEntityProfile } from '@/lib/services/entity.service';
import { ToolConfigService } from '@/lib/services/tool-config.service';
import { calculateAge } from '@/lib/reports/irs-limits';
import { aggregateBookTaxData, expandMappingsToDescendants } from '@/lib/tax/book-income';
import { getLinkedBusinessIncome, applyLinkedBusinessIncome } from '@/lib/tax/linked-business';
import { computeFederalTax, computeSafeHarbor, emptyFederalInputs } from '@/lib/tax/federal';
import { summarizeTaxPayments, resolveContributionActuals } from '@/lib/tax/payments';
import { computeQuarterStatuses, quarterForPaymentDate, type EstimatedPayment } from '@/lib/tax/estimated-quarters';
import {
  FILING_STATUSES,
  isSupportedTaxYear,
  isTaxCategory,
  type BookTaxData,
  type FederalTaxInputs,
  type FilingStatus,
  type TaxCategory,
  type TaxYear,
} from '@/lib/tax/types';

const TOOL_TYPE = 'estimated_tax';
const CONFIG_NAME = 'Estimated tax tracker inputs';

function categoryTotal(bookData: BookTaxData, category: TaxCategory): number {
  return bookData.categories.find(c => c.category === category)?.total ?? 0;
}

/**
 * Annualizable categories — mirrors buildInputs on the tax-estimator page
 * (src/app/(main)/tools/tax-estimator/page.tsx): simple annual flows whose
 * YTD totals scale by 1/elapsedYearFraction.
 */
const ANNUALIZABLE: TaxCategory[] = [
  'w2_wages', 'federal_withholding', 'state_withholding', 'estimated_tax_payment',
  'state_estimated_tax_payment', 'fica_social_security',
  'fica_medicare', 'interest_income', 'tax_exempt_interest', 'ordinary_dividends',
  'qualified_dividends',
  'self_employment_income', 'business_expense', 'rental_income', 'retirement_income',
  'social_security_benefits', 'charitable_donation', 'mortgage_interest',
  'property_tax', 'state_local_tax_paid', 'medical_expense', 'education_expense',
  'other_income', 'other_deduction',
];

/** Server-side twin of the estimator page's buildInputs (always annualized). */
function buildFederalInputs(
  bookData: BookTaxData,
  year: TaxYear,
  filingStatus: FilingStatus,
  filersAge65Plus: number,
  qualifyingChildrenUnder17: number,
): FederalTaxInputs {
  const factor = bookData.elapsedYearFraction < 1 ? 1 / bookData.elapsedYearFraction : 1;
  const get = (c: TaxCategory) =>
    categoryTotal(bookData, c) * (ANNUALIZABLE.includes(c) ? factor : 1);

  const qualifiedDividends = get('qualified_dividends');
  const { trad401k, tradIra, hsa, sepIra, simpleIra } = resolveContributionActuals(bookData);

  return {
    ...emptyFederalInputs(year, filingStatus),
    wages: get('w2_wages'),
    interest: get('interest_income'),
    taxExemptInterest: get('tax_exempt_interest'),
    ordinaryDividends: get('ordinary_dividends') + qualifiedDividends,
    qualifiedDividends,
    shortTermCapitalGains: bookData.realizedGains.shortTerm,
    longTermCapitalGains: bookData.realizedGains.longTerm,
    selfEmploymentIncome: get('self_employment_income') - get('business_expense'),
    rentalIncome: get('rental_income'),
    retirementIncome: get('retirement_income'),
    socialSecurityBenefits: get('social_security_benefits'),
    otherIncome: get('other_income'),
    traditional401kContributions: trad401k,
    traditionalIraContributions: tradIra,
    hsaContributions: hsa,
    sepIraContributions: sepIra,
    simpleIraContributions: simpleIra,
    qualifyingChildrenUnder17,
    charitableDonations: get('charitable_donation'),
    mortgageInterest: get('mortgage_interest'),
    stateLocalTaxesPaid: get('state_withholding') + get('state_estimated_tax_payment')
      + get('property_tax') + get('state_local_tax_paid'),
    medicalExpenses: get('medical_expense'),
    otherDeductions: get('other_deduction'),
    filersAge65Plus,
  };
}

function parseMoney(raw: string | null): number | null {
  if (raw === null || raw === '') return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

interface PinnedPriorYear {
  priorYearTax?: number;
  priorYearAgi?: number;
}

async function loadPinnedPriorYear(userId: number, bookGuid: string): Promise<PinnedPriorYear> {
  const configs = await ToolConfigService.listByUser(userId, bookGuid, TOOL_TYPE);
  const config = configs[0]?.config;
  if (!config || typeof config !== 'object') return {};
  const c = config as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  return { priorYearTax: num(c.priorYearTax), priorYearAgi: num(c.priorYearAgi) };
}

/** Actual 1040-ES payments: splits in accounts mapped to 'estimated_tax_payment'. */
async function loadEstimatedPayments(
  bookAccountGuids: string[],
  year: number,
): Promise<Array<EstimatedPayment & { description: string | null }>> {
  const mappingRows = await prisma.gnucash_web_tax_mappings.findMany({
    where: { account_guid: { in: bookAccountGuids } },
  });
  const direct = new Map<string, TaxCategory>();
  for (const row of mappingRows) {
    if (isTaxCategory(row.tax_category)) direct.set(row.account_guid, row.tax_category);
  }
  if (direct.size === 0) return [];

  const accountRows = await prisma.$queryRaw<Array<{ guid: string; parent_guid: string | null }>>`
    SELECT guid, parent_guid FROM account_hierarchy WHERE guid = ANY(${bookAccountGuids})
  `;
  const mappings = expandMappingsToDescendants(direct, accountRows);
  const paymentGuids = [...mappings.entries()]
    .filter(([, category]) => category === 'estimated_tax_payment')
    .map(([guid]) => guid);
  if (paymentGuids.length === 0) return [];

  // Window covers the whole installment schedule: the Q4 voucher for `year`
  // is paid by Jan 15 of year+1 (query through end of January to catch late
  // Q4 payments — bucketing attributes them to Q4).
  const startDate = new Date(Date.UTC(year, 0, 1));
  const endDate = new Date(Date.UTC(year + 1, 0, 31, 23, 59, 59));

  const rows = await prisma.$queryRaw<Array<{
    post_date: Date;
    amount: number | null;
    description: string | null;
  }>>`
    SELECT t.post_date,
           (s.value_num::numeric / s.value_denom)::float8 AS amount,
           t.description
    FROM splits s
    JOIN transactions t ON s.tx_guid = t.guid
    WHERE s.account_guid = ANY(${paymentGuids})
      AND t.post_date >= ${startDate}
      AND t.post_date <= ${endDate}
      -- skip lot-scrub value-only bookkeeping splits (see book-income.ts)
      AND NOT (s.quantity_num = 0 AND s.value_num <> 0)
    ORDER BY t.post_date ASC
  `;

  return rows
    .filter(r => r.amount !== null && Math.abs(r.amount) >= 0.005)
    .map(r => ({
      date: r.post_date.toISOString().slice(0, 10),
      amount: Math.round((r.amount ?? 0) * 100) / 100,
      description: r.description,
    }));
}

/**
 * GET /api/tax/estimated?year=2026&priorYearTax=...&priorYearAgi=...
 *
 * Quarterly estimated-tax tracker for a HOUSEHOLD book: projected full-year
 * federal liability (including linked business profit), safe-harbor target,
 * per-quarter required vs paid, and shortfall/surplus. Prior-year figures
 * come from query params (preview) or the pinned tool config; use PUT to
 * persist them. Other entity types get { applicable: false }.
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
    const year = Number.isFinite(yearParam) ? yearParam : new Date().getFullYear();
    if (!isSupportedTaxYear(year)) {
      return NextResponse.json(
        { error: `Unsupported tax year ${year}. Supported years: 2024, 2025, 2026.` },
        { status: 400 },
      );
    }

    const entity = await getEntityProfile(bookGuid, user.id);
    if (entity.entityType !== 'household') {
      return NextResponse.json({ applicable: false, entityType: entity.entityType });
    }

    /* --- Filing status / member context (mirrors /api/tax/estimate) --- */
    const [filingStatusPref, birthdayPref] = await Promise.all([
      getPreference<string>(user.id, 'tax_filing_status', 'single'),
      getPreference<string | null>(user.id, 'birthday', null),
    ]);
    const filingStatusRaw = entity.filingStatus ?? filingStatusPref;
    const filingStatus: FilingStatus = (FILING_STATUSES as readonly string[]).includes(filingStatusRaw)
      ? (filingStatusRaw as FilingStatus)
      : 'single';

    const selfMember = entity.members.find(m => m.role === 'self') ?? null;
    const spouseMember = entity.members.find(m => m.role === 'spouse') ?? null;
    const birthday = (!entity.synthesized && selfMember?.birthday) || birthdayPref;

    const yearEnd = new Date(`${year}-12-31`);
    const countsSpouse = filingStatus === 'mfj' || filingStatus === 'qss';
    const ages = [
      birthday ? calculateAge(birthday, yearEnd) : null,
      countsSpouse && spouseMember?.birthday ? calculateAge(spouseMember.birthday, yearEnd) : null,
    ];
    const filersAge65Plus = ages.filter(a => a !== null && a >= 65).length;
    const dependentsUnder17 = entity.members.filter(m => {
      if (m.role !== 'dependent' || !m.birthday) return false;
      const age = calculateAge(m.birthday, yearEnd);
      return age !== null && age < 17;
    }).length;

    /* --- Aggregate book data + linked business profit ------------------ */
    const bookAccountGuids = await getBookAccountGuids();
    const bookData = await aggregateBookTaxData(bookAccountGuids, year, birthday);

    let linkedBusinesses: Awaited<ReturnType<typeof getLinkedBusinessIncome>> = [];
    try {
      linkedBusinesses = await getLinkedBusinessIncome(bookGuid, year);
      applyLinkedBusinessIncome(bookData, linkedBusinesses);
    } catch (err) {
      console.error('Estimated tax: linked-business aggregation failed:', err);
    }

    /* --- Projected full-year federal liability ------------------------- */
    const inputs = buildFederalInputs(
      bookData, year, filingStatus, filersAge65Plus, dependentsUnder17,
    );
    const federal = computeFederalTax(inputs);

    /* --- Withholding (annualized for the target, YTD for display) ------ */
    const factor = bookData.elapsedYearFraction < 1 ? 1 / bookData.elapsedYearFraction : 1;
    const annualized = summarizeTaxPayments(bookData, factor);
    const ytd = summarizeTaxPayments(bookData, 1);

    /* --- Safe harbor ---------------------------------------------------- */
    const pinned = await loadPinnedPriorYear(user.id, bookGuid);
    const priorYearTax = parseMoney(searchParams.get('priorYearTax')) ?? pinned.priorYearTax ?? null;
    const priorYearAgi = parseMoney(searchParams.get('priorYearAgi')) ?? pinned.priorYearAgi ?? null;

    const safeHarbor = computeSafeHarbor({
      year,
      filingStatus,
      currentYearTax: federal.totalTax,
      priorYearTax,
      priorYearAgi,
      withholding: annualized.withholding,
    });

    /* --- Quarterly progress --------------------------------------------- */
    const payments = await loadEstimatedPayments(bookAccountGuids, year);
    const quarters = computeQuarterStatuses({
      year,
      annualTarget: safeHarbor.requiredAnnualPayment,
      annualWithholding: annualized.withholding,
      payments,
    });

    return NextResponse.json({
      applicable: true,
      year,
      asOfDate: bookData.asOfDate,
      elapsedYearFraction: bookData.elapsedYearFraction,
      filingStatus,
      projected: {
        totalTax: federal.totalTax,
        agi: federal.agi,
        effectiveRate: federal.effectiveRate,
        selfEmploymentTax: federal.selfEmploymentTax,
      },
      linkedBusinesses: linkedBusinesses.map(b => ({
        name: b.entityName ?? b.businessBookName,
        share: b.share,
        treatment: b.treatment,
      })),
      priorYear: {
        tax: priorYearTax,
        agi: priorYearAgi,
        pinned: pinned.priorYearTax !== undefined || pinned.priorYearAgi !== undefined,
      },
      safeHarbor,
      withholding: {
        ytd: ytd.withholding,
        annualized: annualized.withholding,
      },
      estimatedPayments: {
        totalYtd: ytd.estimatedPayments,
        list: payments.map(p => ({
          ...p,
          quarter: quarterForPaymentDate(p.date, year),
        })),
      },
      quarters,
    });
  } catch (error) {
    console.error('Error generating estimated tax tracker:', error);
    return NextResponse.json({ error: 'Failed to generate estimated tax tracker' }, { status: 500 });
  }
}

/**
 * PUT /api/tax/estimated
 *
 * Persists prior-year safe-harbor figures to the user+book tool config
 * (tool_type 'estimated_tax'). Body: { priorYearTax?: number, priorYearAgi?: number }.
 * Auth: edit.
 */
export async function PUT(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const num = (v: unknown) =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
    const config: Record<string, number> = {};
    const priorYearTax = num((body as Record<string, unknown>).priorYearTax);
    const priorYearAgi = num((body as Record<string, unknown>).priorYearAgi);
    if (priorYearTax !== undefined) config.priorYearTax = priorYearTax;
    if (priorYearAgi !== undefined) config.priorYearAgi = priorYearAgi;
    if (Object.keys(config).length === 0) {
      return NextResponse.json({ error: 'No valid inputs to save' }, { status: 400 });
    }

    const existing = await ToolConfigService.listByUser(user.id, bookGuid, TOOL_TYPE);
    if (existing.length > 0) {
      const merged = {
        ...(typeof existing[0].config === 'object' && existing[0].config !== null
          ? existing[0].config as Record<string, unknown>
          : {}),
        ...config,
      };
      await ToolConfigService.update(existing[0].id, user.id, bookGuid, { config: merged });
    } else {
      await ToolConfigService.create(user.id, bookGuid, {
        toolType: TOOL_TYPE,
        name: CONFIG_NAME,
        config,
      });
    }

    return NextResponse.json({ ok: true, saved: config });
  } catch (error) {
    console.error('Error saving estimated tax inputs:', error);
    return NextResponse.json({ error: 'Failed to save inputs' }, { status: 500 });
  }
}
