import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids, getAccountGuidsForBook } from '@/lib/book-scope';
import { getEntityProfile } from '@/lib/services/entity.service';
import { getLinksForBusinessBook } from '@/lib/services/book-links.service';
import { ToolConfigService } from '@/lib/services/tool-config.service';
import { aggregateBookTaxData } from '@/lib/tax/book-income';
import {
  compareScenarios,
  soloEmployerCapacity,
  MODEL_ASSUMPTIONS,
} from '@/lib/tax/s-corp-analysis';
import {
  FILING_STATUSES,
  isSupportedTaxYear,
  type BookTaxData,
  type FilingStatus,
  type TaxCategory,
} from '@/lib/tax/types';

/** Entity types the S-corp election analysis applies to. */
const APPLICABLE_TYPES = new Set(['sole_prop', 'llc_single', 'llc_partnership', 's_corp']);

const TOOL_TYPE = 's_corp_analyzer';
const CONFIG_NAME = 'S-corp analyzer inputs';

const DEFAULT_PAYROLL_COST = 600;
const DEFAULT_PREP_COST = 800;
const DEFAULT_FRANCHISE_TAX = 200;

function categoryTotal(data: BookTaxData, category: TaxCategory): number {
  return data.categories.find(c => c.category === category)?.total ?? 0;
}

function parseMoney(raw: string | null): number | null {
  if (raw === null || raw === '') return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

interface PinnedInputs {
  salary?: number;
  payrollCost?: number;
  prepCost?: number;
  franchiseTax?: number;
}

async function loadPinnedInputs(userId: number, bookGuid: string): Promise<PinnedInputs> {
  const configs = await ToolConfigService.listByUser(userId, bookGuid, TOOL_TYPE);
  const config = configs[0]?.config;
  if (!config || typeof config !== 'object') return {};
  const c = config as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  return {
    salary: num(c.salary),
    payrollCost: num(c.payrollCost),
    prepCost: num(c.prepCost),
    franchiseTax: num(c.franchiseTax),
  };
}

/**
 * GET /api/business/s-corp-analysis
 *
 * Query params (all optional — pinned tool config, then defaults, fill gaps):
 *   year          Tax year (default: current). Must be 2024–2026.
 *   salary        Proposed reasonable salary (default: pinned, else 50% of
 *                 annualized profit rounded to $1k, floor $30k, cap profit).
 *   payrollCost   Annual payroll service cost (default 600)
 *   prepCost      Incremental 1120-S tax prep cost (default 800)
 *   franchiseTax  Annual state franchise/entity tax (default 200)
 *
 * Auth: readonly. Active book must be a pass-through business.
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
    if (!APPLICABLE_TYPES.has(entity.entityType)) {
      return NextResponse.json({ applicable: false, entityType: entity.entityType });
    }

    const warnings: string[] = [];

    /* --- YTD net profit from the active (business) book --------------- */
    const bookAccountGuids = await getBookAccountGuids();
    const bookData = await aggregateBookTaxData(bookAccountGuids, year, null);
    const ytdNetProfit =
      categoryTotal(bookData, 'self_employment_income') -
      categoryTotal(bookData, 'business_expense');
    const elapsed = bookData.elapsedYearFraction;
    const annualizedProfit =
      elapsed > 0 ? Math.round((ytdNetProfit / elapsed) * 100) / 100 : ytdNetProfit;

    /* --- Household context via the first outgoing book link ----------- */
    const links = await getLinksForBusinessBook(bookGuid);
    const link = links[0] ?? null;

    let ownershipPercent = 100;
    let otherHouseholdOrdinaryIncome = 0;
    let otherHouseholdSeIncome = 0;
    let otherHouseholdW2Wages = 0;
    let filingStatus: FilingStatus = 'single';
    let linkedHousehold: { name: string | null; filingStatus: FilingStatus } | null = null;

    if (link) {
      ownershipPercent = link.ownershipPercent;
      const hhGuids = await getAccountGuidsForBook(link.householdBookGuid);
      const hhProfile = await getEntityProfile(link.householdBookGuid, user.id);
      const hhData = await aggregateBookTaxData(hhGuids, year, null);
      const hhElapsed = hhData.elapsedYearFraction > 0 ? hhData.elapsedYearFraction : 1;
      // Annualize household YTD figures so marginal rates reflect a full year.
      const annualizedCat = (cat: TaxCategory) => categoryTotal(hhData, cat) / hhElapsed;

      otherHouseholdW2Wages = annualizedCat('w2_wages');
      // Ordinary income stack outside this business: wages, interest,
      // dividends, rental, retirement income, other income.
      otherHouseholdOrdinaryIncome =
        Math.round(
          (otherHouseholdW2Wages +
            annualizedCat('interest_income') +
            annualizedCat('ordinary_dividends') +
            annualizedCat('rental_income') +
            annualizedCat('retirement_income') +
            annualizedCat('other_income')) * 100,
        ) / 100;
      // Household-side SE income (e.g. spouse's Schedule C) — kept separate
      // so its SE tax cancels between scenarios.
      otherHouseholdSeIncome = Math.max(
        0,
        Math.round(
          (annualizedCat('self_employment_income') - annualizedCat('business_expense')) * 100,
        ) / 100,
      );

      const hhStatus = hhProfile.filingStatus;
      filingStatus =
        hhStatus && (FILING_STATUSES as readonly string[]).includes(hhStatus)
          ? (hhStatus as FilingStatus)
          : 'single';
      linkedHousehold = { name: link.householdBookName, filingStatus };
    } else {
      const bizStatus = entity.filingStatus;
      filingStatus =
        bizStatus && (FILING_STATUSES as readonly string[]).includes(bizStatus)
          ? (bizStatus as FilingStatus)
          : 'single';
      warnings.push(
        'No household book is linked to this business — link one in book settings for accurate marginal rates. Assuming 100% ownership and no other household income.',
      );
    }

    /* --- Resolve inputs: query param > pinned config > default --------- */
    const pinned = await loadPinnedInputs(user.id, bookGuid);

    const defaultSalary = Math.min(
      Math.max(30_000, Math.round((0.5 * Math.max(0, annualizedProfit)) / 1000) * 1000),
      Math.max(0, annualizedProfit),
    );
    const salary = parseMoney(searchParams.get('salary')) ?? pinned.salary ?? defaultSalary;
    const payrollServiceCost =
      parseMoney(searchParams.get('payrollCost')) ?? pinned.payrollCost ?? DEFAULT_PAYROLL_COST;
    const taxPrepCost =
      parseMoney(searchParams.get('prepCost')) ?? pinned.prepCost ?? DEFAULT_PREP_COST;
    const stateFranchiseTax =
      parseMoney(searchParams.get('franchiseTax')) ?? pinned.franchiseTax ?? DEFAULT_FRANCHISE_TAX;

    /* --- Run the comparison ------------------------------------------- */
    const result = compareScenarios({
      year,
      filingStatus,
      annualProfit: annualizedProfit,
      ownershipPercent,
      reasonableSalary: salary,
      payrollServiceCost,
      taxPrepCost,
      stateFranchiseTax,
      otherHouseholdOrdinaryIncome,
      otherHouseholdSeIncome,
      otherHouseholdW2Wages,
    });

    if (result.salaryClamped) {
      warnings.push(
        'The proposed salary exceeds annualized profit and was clamped — an S-corp cannot pay more salary than it earns.',
      );
    }

    /* --- Solo-401k employer capacity under each structure -------------- */
    const ownerProfit = Math.max(0, annualizedProfit) * (ownershipPercent / 100);
    const retirement = {
      llcEmployerMax: soloEmployerCapacity(year, 'pass_through', ownerProfit),
      scorpEmployerMax: soloEmployerCapacity(year, 's_corp', result.scorp.salaryUsed),
    };

    return NextResponse.json({
      applicable: true,
      year,
      ytdNetProfit: Math.round(ytdNetProfit * 100) / 100,
      annualizedProfit,
      elapsedYearFraction: elapsed,
      ownershipPercent,
      linkedHousehold,
      inputs: {
        salary: result.scorp.salaryUsed,
        requestedSalary: salary,
        payrollCost: payrollServiceCost,
        prepCost: taxPrepCost,
        franchiseTax: stateFranchiseTax,
        filingStatus,
        otherHouseholdOrdinaryIncome,
        otherHouseholdSeIncome,
        pinned: pinned.salary !== undefined || pinned.payrollCost !== undefined,
      },
      llc: result.llc,
      scorp: result.scorp,
      savings: result.savings,
      breakevenProfit: result.breakevenProfit,
      breakevenCurve: result.breakevenCurve,
      retirement,
      warnings,
      assumptions: MODEL_ASSUMPTIONS,
    });
  } catch (error) {
    console.error('Error generating S-corp analysis:', error);
    return NextResponse.json({ error: 'Failed to generate S-corp analysis' }, { status: 500 });
  }
}

/**
 * PUT /api/business/s-corp-analysis
 *
 * Pins the analyzer inputs (salary, payrollCost, prepCost, franchiseTax) to
 * the user+book tool config so GET uses them as defaults. Auth: edit.
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
    const salary = num((body as Record<string, unknown>).salary);
    const payrollCost = num((body as Record<string, unknown>).payrollCost);
    const prepCost = num((body as Record<string, unknown>).prepCost);
    const franchiseTax = num((body as Record<string, unknown>).franchiseTax);
    if (salary !== undefined) config.salary = salary;
    if (payrollCost !== undefined) config.payrollCost = payrollCost;
    if (prepCost !== undefined) config.prepCost = prepCost;
    if (franchiseTax !== undefined) config.franchiseTax = franchiseTax;
    if (Object.keys(config).length === 0) {
      return NextResponse.json({ error: 'No valid inputs to pin' }, { status: 400 });
    }

    const existing = await ToolConfigService.listByUser(user.id, bookGuid, TOOL_TYPE);
    if (existing.length > 0) {
      await ToolConfigService.update(existing[0].id, user.id, bookGuid, { config });
    } else {
      await ToolConfigService.create(user.id, bookGuid, {
        toolType: TOOL_TYPE,
        name: CONFIG_NAME,
        config,
      });
    }

    return NextResponse.json({ ok: true, pinned: config });
  } catch (error) {
    console.error('Error pinning S-corp analyzer inputs:', error);
    return NextResponse.json({ error: 'Failed to pin inputs' }, { status: 500 });
  }
}
