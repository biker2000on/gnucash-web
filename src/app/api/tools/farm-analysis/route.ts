import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids, getAccountGuidsForBook } from '@/lib/book-scope';
import { getEntityProfile } from '@/lib/services/entity.service';
import { getLinksForBusinessBook } from '@/lib/services/book-links.service';
import { hasMinimumRole } from '@/lib/services/permission.service';
import { ToolConfigService } from '@/lib/services/tool-config.service';
import { aggregateBookTaxData } from '@/lib/tax/book-income';
import { buildHouseholdIncomeContext } from '@/lib/tax/household-income-context';
import { FarmCurrencyConversionError } from '@/lib/tax/farm-currency';
import {
  aggregateFarmBookData,
  FARM_ANALYZER_TOOL_TYPE,
} from '@/lib/tax/farm-book-data';
import { generateScheduleF } from '@/lib/business/schedule-f-report';
import { FARM_CAPABLE_ENTITY_TYPES } from '@/lib/book-templates';
import { analyzeFarmScenarios, MODEL_ASSUMPTIONS } from '@/lib/tax/farm-analysis';
import {
  DEFAULT_COMBINED_SALES_TAX_RATE,
  EXEMPT_PURCHASE_CATEGORIES,
  NC_FARM_ASSUMPTION_NOTES,
} from '@/lib/tax/nc-farm-rules';
import {
  FILING_STATUSES,
  SUPPORTED_TAX_YEARS,
  isSupportedTaxYear,
  type FilingStatus,
} from '@/lib/tax/types';

const TOOL_TYPE = FARM_ANALYZER_TOOL_TYPE;
const CONFIG_NAME = 'Farm analyzer inputs';

function parseMoney(raw: string | null): number | null {
  if (raw === null || raw === '') return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Non-negative finite number, else undefined. */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

interface PinnedInputs {
  farmIncomeAccountGuids?: string[];
  farmExpenseAccountGuids?: string[];
  equipment?: number;
  purchases?: number;
  salesTaxRate?: number;
  acreage?: number;
  priorYearFarmIncome?: number;
  isFirstLlcYear?: boolean;
}

/**
 * Strict 32-char guid array: returns undefined when `v` is not an array OR
 * contains any malformed entry — a partially-invalid payload is rejected
 * rather than silently filtered (which could wipe a pinned selection).
 */
function guidArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const guids = v.filter(
    (g): g is string => typeof g === 'string' && g.length === 32,
  );
  return guids.length === v.length ? guids : undefined;
}

async function loadPinnedInputs(_userId: number, bookGuid: string): Promise<PinnedInputs> {
  const shared = await ToolConfigService.getBookSingleton(bookGuid, TOOL_TYPE);
  const config = shared?.config;
  if (!config || typeof config !== 'object') return {};
  const c = config as Record<string, unknown>;
  return {
    farmIncomeAccountGuids: guidArray(c.farmIncomeAccountGuids),
    farmExpenseAccountGuids: guidArray(c.farmExpenseAccountGuids),
    equipment: num(c.equipment),
    purchases: num(c.purchases),
    salesTaxRate: num(c.salesTaxRate),
    acreage: num(c.acreage),
    priorYearFarmIncome: num(c.priorYearFarmIncome),
    isFirstLlcYear: typeof c.isFirstLlcYear === 'boolean' ? c.isFirstLlcYear : undefined,
  };
}

/**
 * GET /api/tools/farm-analysis
 *
 * Compares unreported-cash / hobby / Schedule F / Schedule F + LLC for the
 * household's farm activity. Works on ANY book:
 * - Pass-through business book: the whole book is the farm (profit via tax
 *   categories, household context via book links — same as the S-corp
 *   analyzer).
 * - Household book (the common starting point): farm income/expense subtree
 *   roots are pinned via PUT; actuals are aggregated from those subtrees and
 *   the rest of the book supplies the other-household-income context.
 *
 * Query params (optional; query > pinned > default):
 *   year, gross, expenses, equipment, purchases, salesTaxRate, priorYear,
 *   acreage, firstYear (1|0)
 *
 * Auth: readonly.
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const { searchParams } = new URL(request.url);
    const rawYear = searchParams.get('year');
    const yearParam = parseInt(rawYear ?? '', 10);
    if (rawYear !== null && !Number.isFinite(yearParam)) {
      return NextResponse.json({ error: 'Invalid year' }, { status: 400 });
    }
    const year = Number.isFinite(yearParam) ? yearParam : new Date().getFullYear();
    if (!isSupportedTaxYear(year)) {
      return NextResponse.json(
        {
          error: `Unsupported tax year ${year}. Supported years: ${SUPPORTED_TAX_YEARS.join(', ')}.`,
        },
        { status: 400 },
      );
    }

    const [entity, pinned, bookAccountGuids] = await Promise.all([
      getEntityProfile(bookGuid, user.id),
      loadPinnedInputs(user.id, bookGuid),
      getBookAccountGuids(),
    ]);
    const warnings: string[] = [];

    const isFarmBusinessBook =
      FARM_CAPABLE_ENTITY_TYPES.has(entity.entityType) &&
      entity.businessActivity === 'farm';

    let ytdGross = 0;
    let ytdExpenses = 0;
    let elapsed = 1;
    let otherHouseholdOrdinaryIncome = 0;
    let otherHouseholdSeIncome = 0;
    let otherHouseholdW2Wages = 0;
    let filingStatus: FilingStatus = 'single';
    let incomeAccounts: unknown[] = [];
    let expenseAccounts: unknown[] = [];
    let loadPriorFarmIncome: (historyYear: number) => Promise<number>;

    if (isFarmBusinessBook) {
      /* --- The whole book is the farm --------------------------------- */
      const [bookData, links, scheduleF] = await Promise.all([
        aggregateBookTaxData(bookAccountGuids, year, null),
        getLinksForBusinessBook(bookGuid),
        generateScheduleF(bookGuid, bookAccountGuids, year),
      ]);
      ytdGross = scheduleF.grossIncome;
      ytdExpenses = scheduleF.totalExpenses;
      elapsed = bookData.elapsedYearFraction;
      if (scheduleF.convertedCurrencies.length > 0) {
        warnings.push(
          `Converted ${scheduleF.convertedCurrencies.join(', ')} farm transactions into ${scheduleF.currencyCode} using historical posting-date rates.`,
        );
      }

      if (entity.entityType === 'llc_partnership') {
        warnings.push(
          'This book is a multi-member (partnership) LLC — the model treats all profit as one owner’s Schedule F income and does not model K-1 allocation or partnership filing costs.',
        );
      }

      const link = links[0] ?? null;
      // Only aggregate the linked household when the requesting user actually
      // holds a role on that book — otherwise its income totals would leak to
      // business-book-only collaborators.
      const canReadHousehold = link
        ? await hasMinimumRole(user.id, link.householdBookGuid, 'readonly')
        : false;
      if (link && canReadHousehold) {
        const hhGuids = await getAccountGuidsForBook(link.householdBookGuid);
        const [hhProfile, hhData] = await Promise.all([
          getEntityProfile(link.householdBookGuid, user.id),
          aggregateBookTaxData(hhGuids, year, null),
        ]);
        const hh = buildHouseholdIncomeContext(hhData);
        otherHouseholdW2Wages = hh.w2Wages;
        otherHouseholdOrdinaryIncome = hh.ordinaryIncome;
        otherHouseholdSeIncome = hh.seIncome;
        const hhStatus = hhProfile.filingStatus;
        filingStatus =
          hhStatus && (FILING_STATUSES as readonly string[]).includes(hhStatus)
            ? (hhStatus as FilingStatus)
            : 'single';
      } else {
        const bizStatus = entity.filingStatus;
        filingStatus =
          bizStatus && (FILING_STATUSES as readonly string[]).includes(bizStatus)
            ? (bizStatus as FilingStatus)
            : 'single';
        warnings.push(
          link
            ? 'A household book is linked but you don’t have access to it — assuming no other household income.'
            : 'No household book is linked to this business — link one in book settings for accurate marginal rates. Assuming no other household income.',
        );
      }
      loadPriorFarmIncome = async (historyYear) => {
        const report = await generateScheduleF(bookGuid, bookAccountGuids, historyYear);
        return report.grossIncome;
      };
    } else {
      /* --- Household (or general-business) book: pinned farm subtrees --- */
      const incomeRoots = pinned.farmIncomeAccountGuids ?? [];
      const expenseRoots = pinned.farmExpenseAccountGuids ?? [];
      if (incomeRoots.length === 0) {
        return NextResponse.json({
          applicable: true,
          needsSetup: true,
          year,
          entityType: entity.entityType,
          businessActivity: entity.businessActivity,
          assumptions: MODEL_ASSUMPTIONS,
          ncNotes: NC_FARM_ASSUMPTION_NOTES,
          exemptCategories: EXEMPT_PURCHASE_CATEGORIES,
        });
      }

      const [farmData, bookData] = await Promise.all([
        aggregateFarmBookData(bookGuid, bookAccountGuids, incomeRoots, expenseRoots, year),
        aggregateBookTaxData(bookAccountGuids, year, null),
      ]);
      ytdGross = farmData.grossIncome;
      ytdExpenses = farmData.expenses;
      elapsed = farmData.elapsedYearFraction;
      incomeAccounts = farmData.incomeAccounts;
      expenseAccounts = farmData.expenseAccounts;
      if (farmData.convertedCurrencies.length > 0) {
        warnings.push(
          `Converted ${farmData.convertedCurrencies.join(', ')} farm transactions into ${farmData.currencyCode} using historical posting-date rates.`,
        );
      }

      if (farmData.taxMappedFarmGuids.length > 0) {
        warnings.push(
          `${farmData.taxMappedFarmGuids.length} selected farm account(s) also carry a tax-estimator mapping — the tax estimator may double-count this income if you map it there too.`,
        );
      }

      /* Other household income = the book's tax categories minus the farm
         accounts' contribution (per-account amounts are in the aggregates). */
      const farmGuids = new Set([...farmData.incomeGuids, ...farmData.expenseGuids]);
      const hh = buildHouseholdIncomeContext(bookData, farmGuids);
      otherHouseholdW2Wages = hh.w2Wages;
      otherHouseholdOrdinaryIncome = hh.ordinaryIncome;
      otherHouseholdSeIncome = hh.seIncome;

      const status = entity.filingStatus;
      filingStatus =
        status && (FILING_STATUSES as readonly string[]).includes(status)
          ? (status as FilingStatus)
          : 'single';

      if (bookData.mappedAccountCount === 0) {
        warnings.push(
          'No tax-estimator mappings found in this book — other household income is treated as $0, which understates your marginal rate. Map your W-2/income accounts in the tax estimator for accurate deltas.',
        );
      }
      loadPriorFarmIncome = async (historyYear) => {
        const history = await aggregateFarmBookData(
          bookGuid,
          bookAccountGuids,
          incomeRoots,
          expenseRoots,
          historyYear,
        );
        return history.grossIncome;
      };
    }

    /* --- Annualize + resolve inputs (query > pinned > default) --------- */
    const annualize = (v: number) =>
      elapsed > 0 ? Math.round((v / elapsed) * 100) / 100 : v;
    const annualizedGross = annualize(ytdGross);
    const annualizedExpenses = annualize(ytdExpenses);

    const gross = parseMoney(searchParams.get('gross')) ?? annualizedGross;
    const expenses = parseMoney(searchParams.get('expenses')) ?? annualizedExpenses;
    const equipment =
      parseMoney(searchParams.get('equipment')) ?? pinned.equipment ?? 0;
    const purchases =
      parseMoney(searchParams.get('purchases')) ?? pinned.purchases ?? 0;
    // Clamp the rate to a sane ceiling: a raw "7" (meaning 7%) via the API
    // would otherwise become a 700% rate and corrupt every recommendation.
    const salesTaxRate = Math.min(
      0.2,
      parseMoney(searchParams.get('salesTaxRate')) ??
        pinned.salesTaxRate ??
        DEFAULT_COMBINED_SALES_TAX_RATE,
    );
    const priorYearFarmIncome =
      parseMoney(searchParams.get('priorYear')) ?? pinned.priorYearFarmIncome ?? null;
    const derivedPriorThreeYearFarmIncome = await Promise.all(
      [year - 1, year - 2, year - 3].map((historyYear) =>
        loadPriorFarmIncome(historyYear),
      ),
    );
    const priorThreeYearFarmIncome: Array<number | null> = [
      priorYearFarmIncome ?? derivedPriorThreeYearFarmIncome[0],
      derivedPriorThreeYearFarmIncome[1],
      derivedPriorThreeYearFarmIncome[2],
    ];
    const acreage = parseMoney(searchParams.get('acreage')) ?? pinned.acreage ?? null;
    const firstYearParam = searchParams.get('firstYear');
    const isFirstLlcYear =
      firstYearParam !== null ? firstYearParam !== '0' : (pinned.isFirstLlcYear ?? true);

    // Annualizing from a sliver of the year multiplies noise into confident-
    // looking projections — say so.
    const usingActuals =
      searchParams.get('gross') === null && searchParams.get('expenses') === null;
    if (usingActuals && year === new Date().getFullYear() && elapsed < 0.15) {
      warnings.push(
        `Only ${Math.max(1, Math.round(elapsed * 365))} day(s) of ${year} have elapsed — annualized income/expense projections are unreliable this early in the year. Enter full-year estimates manually for a steadier comparison.`,
      );
    }

    if (entity.taxState && entity.taxState !== 'NC') {
      warnings.push(
        `This book's tax state is ${entity.taxState} — the sales-tax exemption, LLC fees, and PUV rules modeled here are North Carolina's. Income/SE tax math still applies.`,
      );
    } else if (!entity.taxState) {
      warnings.push(
        "No tax state is set on this book's entity profile — assuming North Carolina rules. Set the tax state in Settings.",
      );
    }

    /* --- Run the comparison ------------------------------------------- */
    const result = analyzeFarmScenarios({
      year,
      filingStatus,
      taxState: entity.taxState ?? 'NC',
      stateFlatRate: entity.stateFlatRate,
      grossFarmIncome: gross,
      farmExpenses: expenses,
      plannedEquipmentPurchases: equipment,
      annualTaxableFarmPurchases: purchases,
      combinedSalesTaxRate: salesTaxRate,
      priorYearFarmIncome,
      priorThreeYearFarmIncome,
      acreage,
      isFirstLlcYear,
      otherHouseholdOrdinaryIncome,
      otherHouseholdSeIncome,
      otherHouseholdW2Wages,
    });

    return NextResponse.json({
      applicable: true,
      needsSetup: false,
      year,
      entityType: entity.entityType,
      businessActivity: entity.businessActivity,
      taxState: entity.taxState ?? null,
      isFarmBusinessBook,
      ytdGross: Math.round(ytdGross * 100) / 100,
      ytdExpenses: Math.round(ytdExpenses * 100) / 100,
      elapsedYearFraction: elapsed,
      incomeAccounts,
      expenseAccounts,
      inputs: {
        gross,
        expenses,
        equipment,
        purchases,
        salesTaxRate,
        priorYearFarmIncome,
        priorThreeYearFarmIncome,
        acreage,
        isFirstLlcYear,
        filingStatus,
        otherHouseholdOrdinaryIncome,
        otherHouseholdSeIncome,
        farmIncomeAccountGuids: pinned.farmIncomeAccountGuids ?? [],
        farmExpenseAccountGuids: pinned.farmExpenseAccountGuids ?? [],
      },
      ...result,
      warnings: [...warnings, ...result.warnings],
      ncNotes: NC_FARM_ASSUMPTION_NOTES,
      exemptCategories: EXEMPT_PURCHASE_CATEGORIES,
    });
  } catch (error) {
    if (error instanceof FarmCurrencyConversionError) {
      return NextResponse.json(
        { error: error.message, missingRates: error.missingRates },
        { status: 422 },
      );
    }
    console.error('Error generating farm analysis:', error);
    return NextResponse.json({ error: 'Failed to generate farm analysis' }, { status: 500 });
  }
}

/**
 * PUT /api/tools/farm-analysis
 *
 * Pins the analyzer configuration (farm account subtree roots + input
 * assumptions) to the user+book tool config. Auth: edit.
 */
export async function PUT(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const b = body as Record<string, unknown>;

    // Malformed guid arrays are a 400, not a silent filter — a bad payload
    // must never overwrite the pinned selection.
    if (b.farmIncomeAccountGuids !== undefined && guidArray(b.farmIncomeAccountGuids) === undefined) {
      return NextResponse.json({ error: 'Invalid farmIncomeAccountGuids' }, { status: 400 });
    }
    if (b.farmExpenseAccountGuids !== undefined && guidArray(b.farmExpenseAccountGuids) === undefined) {
      return NextResponse.json({ error: 'Invalid farmExpenseAccountGuids' }, { status: 400 });
    }

    // Account guids must belong to the active book AND be the right type
    // for the side they're pinned on (income roots = INCOME accounts).
    const bookAccountGuids = new Set(await getBookAccountGuids());
    const validGuids = (v: unknown): string[] | undefined => {
      const arr = guidArray(v);
      if (arr === undefined) return undefined;
      const bad = arr.filter((g) => !bookAccountGuids.has(g));
      if (bad.length > 0) {
        throw new Error(`Account not in the active book: ${bad[0]}`);
      }
      return arr;
    };

    let incomeGuids: string[] | undefined;
    let expenseGuids: string[] | undefined;
    try {
      incomeGuids = validGuids(b.farmIncomeAccountGuids);
      expenseGuids = validGuids(b.farmExpenseAccountGuids);
      const toCheck = [...(incomeGuids ?? []), ...(expenseGuids ?? [])];
      if (toCheck.length > 0) {
        const rows = await prisma.$queryRaw<Array<{ guid: string; account_type: string }>>`
          SELECT guid, account_type FROM accounts WHERE guid = ANY(${toCheck}::text[])
        `;
        const typeOf = new Map(rows.map((r) => [r.guid, r.account_type]));
        const badIncome = (incomeGuids ?? []).find((g) => typeOf.get(g) !== 'INCOME');
        if (badIncome) throw new Error('Farm income roots must be INCOME accounts');
        const badExpense = (expenseGuids ?? []).find((g) => typeOf.get(g) !== 'EXPENSE');
        if (badExpense) throw new Error('Farm expense roots must be EXPENSE accounts');
      }
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Invalid account selection' },
        { status: 400 },
      );
    }

    const config: Record<string, unknown> = {};
    // Explicit null clears a pinned key (merge would otherwise make stale
    // values like priorYearFarmIncome un-clearable).
    const clears: string[] = [];
    const setOrClear = (key: string, v: unknown) => {
      if (v === null) clears.push(key);
      else {
        const n = num(v);
        if (n !== undefined) config[key] = n;
      }
    };
    if (incomeGuids !== undefined) config.farmIncomeAccountGuids = incomeGuids;
    if (expenseGuids !== undefined) config.farmExpenseAccountGuids = expenseGuids;
    setOrClear('equipment', b.equipment);
    setOrClear('purchases', b.purchases);
    setOrClear('salesTaxRate', b.salesTaxRate);
    setOrClear('acreage', b.acreage);
    setOrClear('priorYearFarmIncome', b.priorYearFarmIncome);
    if (typeof b.isFirstLlcYear === 'boolean') config.isFirstLlcYear = b.isFirstLlcYear;

    if (Object.keys(config).length === 0 && clears.length === 0) {
      return NextResponse.json({ error: 'No valid inputs to pin' }, { status: 400 });
    }

    await ToolConfigService.mergeBookSingleton(
      bookGuid,
      TOOL_TYPE,
      CONFIG_NAME,
      config,
      clears,
    );

    return NextResponse.json({ ok: true, pinned: config, cleared: clears });
  } catch (error) {
    console.error('Error pinning farm analyzer inputs:', error);
    return NextResponse.json({ error: 'Failed to pin inputs' }, { status: 500 });
  }
}
