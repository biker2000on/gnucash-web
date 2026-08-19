import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { getPreference } from '@/lib/user-preferences';
import { getEntityProfile } from '@/lib/services/entity.service';
import { ToolConfigService } from '@/lib/services/tool-config.service';
import { calculateAge } from '@/lib/reports/irs-limits';
import { aggregateBookTaxData, expandMappingsToDescendants } from '@/lib/tax/book-income';
import { getLinkedBusinessIncome, applyLinkedBusinessIncome } from '@/lib/tax/linked-business';
import { computeFederalTax, computeSafeHarbor } from '@/lib/tax/federal';
import { summarizeTaxPayments } from '@/lib/tax/payments';
import { applyHouseholdTaxDetails, buildFederalInputsFromBookData } from '@/lib/tax/estimator-inputs';
import { getContributionLimit } from '@/lib/reports/irs-limits';
import {
  computeQuarterStatuses,
  quarterForPaymentDate,
  sumPaymentsForTaxYear,
  type EstimatedPayment,
} from '@/lib/tax/estimated-quarters';
import {
  ANNUALIZATION_FACTORS,
  ANNUALIZATION_PERIOD_ENDS,
  computeAnnualizedInstallments,
} from '@/lib/tax/annualized-installments';
import { createCalculationTrace, persistCalculationTrace } from '@/lib/provenance';
import {
  FILING_STATUSES,
  isSupportedTaxYear,
  isTaxCategory,
  type FilingStatus,
  type TaxCategory,
} from '@/lib/tax/types';

const TOOL_TYPE = 'estimated_tax';
const CONFIG_NAME = 'Estimated tax tracker inputs';

// Input assembly is SHARED with the estimator page and withholding checkup
// (buildFederalInputsFromBookData + applyHouseholdTaxDetails) — do not
// re-implement it here.

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
    const bookAccountGuids = await getAccountGuidsForBook(bookGuid);
    const bookData = await aggregateBookTaxData(bookAccountGuids, year, birthday);

    let linkedBusinesses: Awaited<ReturnType<typeof getLinkedBusinessIncome>> = [];
    try {
      linkedBusinesses = await getLinkedBusinessIncome(bookGuid, year);
      applyLinkedBusinessIncome(bookData, linkedBusinesses);
    } catch (err) {
      console.error('Estimated tax: linked-business aggregation failed:', err);
    }

    /* --- Projected full-year federal liability ------------------------- */
    const factor = bookData.elapsedYearFraction < 1 ? 1 / bookData.elapsedYearFraction : 1;
    const rawInputs = buildFederalInputsFromBookData(
      bookData, year, filingStatus, filersAge65Plus, factor,
    );
    // Household layer (shared with the estimator page + withholding checkup):
    // Child Tax Credit + §219(g) traditional-IRA deduction phase-out cap.
    const [coveredPref, spouseCoveredPref, limitIra, limitSpouseIra] = await Promise.all([
      getPreference<boolean>(user.id, 'tax_covered_by_employer_plan', true),
      getPreference<boolean>(user.id, 'tax_spouse_covered_by_employer_plan', false),
      getContributionLimit(year, 'traditional_ira', birthday),
      getContributionLimit(year, 'traditional_ira', spouseMember?.birthday ?? null),
    ]);
    const { inputs } = applyHouseholdTaxDetails(rawInputs, {
      qualifyingChildrenUnder17: dependentsUnder17,
      coveredByEmployerPlan: !entity.synthesized && selfMember
        ? selfMember.coveredByEmployerPlan
        : (typeof coveredPref === 'boolean' ? coveredPref : true),
      spouseCoveredByEmployerPlan: !entity.synthesized && spouseMember
        ? spouseMember.coveredByEmployerPlan
        : (typeof spouseCoveredPref === 'boolean' ? spouseCoveredPref : false),
      selfIraLimit: limitIra?.total ?? null,
      spouseIraLimit: limitSpouseIra?.total ?? null,
      contributionsByTypeAndOwner: bookData.contributionsByTypeAndOwner,
    });
    const federal = computeFederalTax(inputs);

    /* --- Withholding (annualized for the target, YTD for display) ------ */
    // NOTE: only the WITHHOLDING figures are read off these summaries. The
    // estimated-payment total is bucketed by installment window instead
    // (sumPaymentsForTaxYear below) so the headline agrees with the quarter
    // table on Jan 1–15 vouchers.
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
      isQualifyingFarmer: false,
    });

    /* --- Form 2210 Schedule AI annualized installments ------------------ */
    // Each elapsed period (through Mar 31 / May 31 / Aug 31 / Dec 31) gets
    // its own book aggregation, annualized by the statutory factor, run
    // through the SAME input assembly and engine as the full-year projection.
    // Periods that haven't ended yet fall back to the regular schedule
    // inside computeAnnualizedInstallments.
    const annualizedTaxByColumn: [number | null, number | null, number | null, number | null] =
      [null, null, null, null];
    for (let i = 0; i < 4; i++) {
      const periodEnd = `${year}-${ANNUALIZATION_PERIOD_ENDS[i]}`;
      if (periodEnd > bookData.asOfDate) continue;
      try {
        const periodData = i === 3
          ? bookData // Dec 31 column IS the full-year aggregation
          : await aggregateBookTaxData(bookAccountGuids, year, birthday, periodEnd);
        // Linked-business profit is an annual figure with no period ledger;
        // treat it as accruing evenly (months elapsed / 12), matching the
        // even-accrual treatment of withholding and contributions.
        if (i !== 3 && linkedBusinesses.length > 0) {
          const monthsElapsed = [3, 5, 8][i];
          applyLinkedBusinessIncome(
            periodData,
            linkedBusinesses.map(b => ({ ...b, share: b.share * (monthsElapsed / 12) })),
          );
        }
        const aiFactor = ANNUALIZATION_FACTORS[i];
        const rawPeriodInputs = buildFederalInputsFromBookData(
          periodData, year, filingStatus, filersAge65Plus, aiFactor,
        );
        // Schedule AI annualizes ALL income including capital gains (the
        // shared builder deliberately never annualizes realized gains for
        // the full-year projection, so scale them here).
        const periodInputs = {
          ...rawPeriodInputs,
          shortTermCapitalGains: periodData.realizedGains.shortTerm * aiFactor,
          longTermCapitalGains: periodData.realizedGains.longTerm * aiFactor,
        };
        const { inputs: aiInputs } = applyHouseholdTaxDetails(periodInputs, {
          qualifyingChildrenUnder17: dependentsUnder17,
          coveredByEmployerPlan: !entity.synthesized && selfMember
            ? selfMember.coveredByEmployerPlan
            : (typeof coveredPref === 'boolean' ? coveredPref : true),
          spouseCoveredByEmployerPlan: !entity.synthesized && spouseMember
            ? spouseMember.coveredByEmployerPlan
            : (typeof spouseCoveredPref === 'boolean' ? spouseCoveredPref : false),
          selfIraLimit: limitIra?.total ?? null,
          spouseIraLimit: limitSpouseIra?.total ?? null,
          contributionsByTypeAndOwner: periodData.contributionsByTypeAndOwner,
        });
        annualizedTaxByColumn[i] = computeFederalTax(aiInputs).totalTax;
      } catch (err) {
        // A failed column falls back to the regular schedule for that
        // quarter rather than failing the whole tracker.
        console.error(`Estimated tax: Schedule AI column ${i + 1} aggregation failed:`, err);
      }
    }
    const annualizedMethod = computeAnnualizedInstallments({
      requiredAnnualPayment: safeHarbor.requiredAnnualPayment,
      annualizedTaxByColumn,
      isQualifyingFarmer: false,
    });

    /* --- Quarterly progress --------------------------------------------- */
    const payments = await loadEstimatedPayments(bookAccountGuids, year);
    const estimatedPaymentsTotal = sumPaymentsForTaxYear(payments, year);
    const quarters = computeQuarterStatuses({
      year,
      annualTarget: safeHarbor.requiredAnnualPayment,
      annualWithholding: annualized.withholding,
      payments,
      ...(annualizedMethod.applicable && annualizedMethod.anyBenefit
        ? { requiredCumulativeByQuarter: annualizedMethod.requiredCumulativeByQuarter }
        : {}),
    });

    const responseData = {
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
        totalYtd: estimatedPaymentsTotal,
        list: payments.map(p => ({
          ...p,
          quarter: quarterForPaymentDate(p.date, year),
        })),
      },
      quarters,
      /** Form 2210 Schedule AI comparison; `active` = quarters use it. */
      annualizedMethod: {
        active: annualizedMethod.applicable && annualizedMethod.anyBenefit,
        anyBenefit: annualizedMethod.anyBenefit,
        columns: annualizedMethod.columns,
        assumptions: [
          'Book income through each period end (Mar 31, May 31, Aug 31, Dec 31), annualized by 4 / 2.4 / 1.5 / 1; installments at 22.5% / 45% / 67.5% / 90%.',
          'Withholding, retirement contributions, and linked-business profit are treated as accruing evenly through the year.',
          'Self-employment tax uses the full-year Social Security wage base rather than the Schedule AI Part II prorated base (identical below the cap).',
        ],
      },
    };
    const trace = createCalculationTrace({
      namespace: 'estimated-tax',
      identity: { bookGuid, year, filingStatus },
      title: `${year} estimated-tax safe harbor`,
      summary: 'Projected federal tax, annualized withholding, prior-year safe-harbor inputs, and recorded estimated payments.',
      asOfDate: bookData.asOfDate,
      formula: 'required annual payment − annualized withholding − estimated payments',
      result: safeHarbor.requiredAnnualPayment,
      unit: 'currency',
      steps: [
        {
          key: 'projected-tax',
          label: 'Project current-year federal tax',
          inputs: {
            agi: federal.agi,
            selfEmploymentTax: federal.selfEmploymentTax,
            effectiveRate: federal.effectiveRate,
          },
          result: federal.totalTax,
        },
        {
          key: 'safe-harbor',
          label: 'Apply the lower safe-harbor target',
          inputs: {
            projectedTax: federal.totalTax,
            priorYearTax,
            priorYearAgi,
          },
          result: safeHarbor.requiredAnnualPayment,
        },
        {
          key: 'annualized-installments',
          label: 'Compare the Form 2210 Schedule AI annualized installments',
          inputs: {
            annualizedTaxByColumn: annualizedTaxByColumn
              .map(t => (t === null ? 'period not ended' : String(Math.round(t))))
              .join(' / '),
            requiredAnnualPayment: safeHarbor.requiredAnnualPayment,
          },
          result: annualizedMethod.anyBenefit
            ? annualizedMethod.requiredCumulativeByQuarter[3]
            : safeHarbor.requiredAnnualPayment,
        },
        {
          key: 'payments',
          label: 'Subtract withholding and estimated payments',
          inputs: {
            annualizedWithholding: annualized.withholding,
            estimatedPaymentsYtd: estimatedPaymentsTotal,
          },
          result: quarters.reduce((sum, quarter) => sum + quarter.shortfall, 0),
        },
      ],
      evidence: [
        {
          kind: 'report_query',
          id: `tax-book-data:${year}`,
          label: `${year} tax-mapped account activity`,
          source: 'system',
          href: `/tools/tax-estimator?year=${year}`,
          observedAt: new Date().toISOString(),
          verified: false,
        },
        {
          kind: 'tax_table',
          id: `federal-tax-rules:${year}:${filingStatus}`,
          label: `${year} federal tax rules for ${filingStatus}`,
          source: 'system',
          observedAt: new Date().toISOString(),
          verified: true,
        },
      ],
      assumptions: [
        `Year-to-date annualizable amounts use an elapsed-year factor of ${factor.toFixed(4)}.`,
        priorYearTax === null
          ? 'No prior-year tax was supplied; safe-harbor comparisons may be incomplete.'
          : 'Prior-year tax is supplied or pinned by the user.',
        ...(annualizedMethod.anyBenefit
          ? ['Quarterly requirements use the Form 2210 Schedule AI annualized-installment amounts where lower than the even schedule.']
          : []),
      ],
      warnings: priorYearTax === null
        ? ['Pin prior-year tax and AGI to evaluate both statutory safe-harbor paths.']
        : [],
      metadata: { linkedBusinessCount: linkedBusinesses.length },
    });
    await persistCalculationTrace(user.id, bookGuid, trace);

    return NextResponse.json({
      ...responseData,
      trace: { traceId: trace.id, href: `/api/provenance/${trace.id}` },
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
      await ToolConfigService.upsertUserSingleton(user.id, bookGuid, {
        toolType: TOOL_TYPE,
        name: CONFIG_NAME,
        config: merged,
      });
    } else {
      await ToolConfigService.upsertUserSingleton(user.id, bookGuid, {
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
