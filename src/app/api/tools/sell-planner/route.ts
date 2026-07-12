import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import {
  buildSellPlans,
  loadSellCandidates,
  loadSellTaxContext,
  DEFAULT_ALMOST_LT_DAYS,
} from '@/lib/sell-planner';
import { FILING_STATUSES, type FilingStatus } from '@/lib/tax/types';

/**
 * Tax-Optimal Sell Planner API.
 *
 * GET  — prefill: taxable/retirement STOCK+MUTUAL accounts (scope picker),
 *        the user's current-year tax context (filing status, state, YTD
 *        realized gains, baseline tax), and wash-sale look-back info.
 * POST — { targetCash, accountGuids?, filingStatus?, stateCode?,
 *          stateFlatRate?, annualize?, almostLongTermDays? }
 *        → recommended / naive-FIFO / long-term-only plans with
 *        incremental federal + state tax.
 */

export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const userId = roleResult.user.id;

    const bookAccountGuids = await getBookAccountGuids();
    const [book, tax] = await Promise.all([
      loadSellCandidates(bookAccountGuids),
      loadSellTaxContext(bookAccountGuids, userId),
    ]);

    const taxableValue = book.accounts
      .filter(a => !a.isRetirement)
      .reduce((s, a) => s + a.marketValue, 0);

    return NextResponse.json({
      accounts: book.accounts,
      retirement: book.retirement,
      taxableMarketValue: Math.round(taxableValue * 100) / 100,
      candidateLotCount: book.candidates.length,
      recentBuysByTicker: book.recentBuysByTicker,
      missingPriceTickers: book.missingPriceTickers,
      context: tax.meta,
    });
  } catch (error) {
    console.error('Error prefilling sell planner:', error);
    return NextResponse.json(
      { error: 'Failed to prefill sell planner' },
      { status: 500 },
    );
  }
}

interface PlanRequestBody {
  targetCash?: unknown;
  accountGuids?: unknown;
  filingStatus?: unknown;
  stateCode?: unknown;
  stateFlatRate?: unknown;
  annualize?: unknown;
  almostLongTermDays?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const userId = roleResult.user.id;

    let body: PlanRequestBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const targetCash = Number(body.targetCash);
    if (!Number.isFinite(targetCash) || targetCash <= 0) {
      return NextResponse.json(
        { error: 'targetCash must be a positive number' },
        { status: 400 },
      );
    }

    const accountGuids = Array.isArray(body.accountGuids)
      ? body.accountGuids.filter((g): g is string => typeof g === 'string')
      : undefined;

    const filingStatus =
      typeof body.filingStatus === 'string' &&
      (FILING_STATUSES as readonly string[]).includes(body.filingStatus)
        ? (body.filingStatus as FilingStatus)
        : undefined;
    const stateCode = typeof body.stateCode === 'string' ? body.stateCode : undefined;
    const stateFlatRate =
      typeof body.stateFlatRate === 'number' && Number.isFinite(body.stateFlatRate)
        ? Math.max(0, body.stateFlatRate)
        : undefined;
    const annualize = typeof body.annualize === 'boolean' ? body.annualize : undefined;
    const almostLongTermDays =
      typeof body.almostLongTermDays === 'number' &&
      Number.isFinite(body.almostLongTermDays) &&
      body.almostLongTermDays >= 0
        ? Math.floor(body.almostLongTermDays)
        : DEFAULT_ALMOST_LT_DAYS;

    const bookAccountGuids = await getBookAccountGuids();
    const [book, tax] = await Promise.all([
      loadSellCandidates(bookAccountGuids, accountGuids),
      loadSellTaxContext(bookAccountGuids, userId, {
        filingStatus,
        stateCode,
        stateFlatRate,
        annualize,
      }),
    ]);

    const asOf = new Date().toISOString().slice(0, 10);
    const plans = buildSellPlans(book.candidates, targetCash, tax.context, {
      asOf,
      almostLongTermDays,
      recentBuysByTicker: book.recentBuysByTicker,
    });

    return NextResponse.json({
      asOf,
      plans,
      retirement: book.retirement,
      missingPriceTickers: book.missingPriceTickers,
      context: tax.meta,
    });
  } catch (error) {
    console.error('Error building sell plan:', error);
    return NextResponse.json(
      { error: 'Failed to build sell plan' },
      { status: 500 },
    );
  }
}
