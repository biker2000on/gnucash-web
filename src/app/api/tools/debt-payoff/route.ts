import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { compareStrategies } from '@/lib/debt-payoff';

const TOOL_TYPE = 'debt-payoff';
const CONFIG_NAME = 'Debt Payoff Plan';

/**
 * Per-debt user config saved in gnucash_web_tool_config.config.debts,
 * keyed by account GUID.
 */
interface SavedDebtConfig {
  apr?: number;
  minPayment?: number;
  include?: boolean;
}

interface SavedPlannerConfig {
  debts?: Record<string, SavedDebtConfig>;
  settings?: {
    extraMonthly?: number;
    strategy?: 'snowball' | 'avalanche';
  };
}

interface MortgageToolConfig {
  interestRate?: number;
  originalAmount?: number;
  loanTermMonths?: number;
}

/** Standard amortization payment: M = P * r(1+r)^n / ((1+r)^n - 1) */
function amortizedMonthlyPayment(
  principal: number,
  annualRatePct: number,
  months: number
): number | null {
  if (!(principal > 0) || !(months > 0)) return null;
  const r = annualRatePct / 100 / 12;
  if (r <= 0) return principal / months;
  const rn = Math.pow(1 + r, months);
  return (principal * r * rn) / (rn - 1);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function loadSavedConfig(userId: number, bookGuid: string) {
  return prisma.gnucash_web_tool_config.findFirst({
    where: { user_id: userId, book_guid: bookGuid, tool_type: TOOL_TYPE },
    orderBy: { updated_at: 'desc' },
  });
}

/**
 * GET /api/tools/debt-payoff
 *
 * Returns all liability-type accounts (LIABILITY, CREDIT, PAYABLE) in the
 * active book with current balances, merged with saved per-debt config and
 * planner settings.
 *
 * Sign convention: GnuCash stores liability balances as credits (negative
 * split sums). This endpoint normalizes to `balance` = positive amount owed
 * (i.e. -sum of splits). `rawBalance` carries the original GnuCash sign.
 */
export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const bookAccountGuids = await getBookAccountGuids();

    const rows = await prisma.$queryRaw<
      Array<{
        guid: string;
        name: string;
        account_type: string;
        currency: string | null;
        balance: number | null;
      }>
    >`
      SELECT a.guid,
             a.name,
             a.account_type,
             c.mnemonic AS currency,
             COALESCE(SUM(
               CAST(s.value_num AS DOUBLE PRECISION) /
               NULLIF(CAST(s.value_denom AS DOUBLE PRECISION), 0)
             ), 0) AS balance
      FROM accounts a
      LEFT JOIN splits s ON s.account_guid = a.guid
      LEFT JOIN commodities c ON c.guid = a.commodity_guid
      WHERE a.guid = ANY(${bookAccountGuids}::text[])
        AND a.account_type IN ('LIABILITY', 'CREDIT', 'PAYABLE')
        AND COALESCE(a.placeholder, 0) = 0
        AND COALESCE(a.hidden, 0) = 0
      GROUP BY a.guid, a.name, a.account_type, c.mnemonic
      ORDER BY a.name
    `;

    // Saved planner config (per-debt APR / minimum payment / include + settings)
    const savedRow = await loadSavedConfig(user.id, bookGuid);
    const saved = (savedRow?.config ?? {}) as SavedPlannerConfig;
    const savedDebts = saved.debts ?? {};

    // Cheap mortgage prefill: reuse saved mortgage tool configs (which carry
    // the detected/entered interest rate) rather than re-running detection.
    const mortgageConfigs = await prisma.gnucash_web_tool_config.findMany({
      where: {
        user_id: user.id,
        book_guid: bookGuid,
        tool_type: 'mortgage',
        account_guid: { not: null },
      },
      orderBy: { updated_at: 'desc' },
    });
    const mortgageByAccount = new Map<string, MortgageToolConfig>();
    for (const mc of mortgageConfigs) {
      if (mc.account_guid && !mortgageByAccount.has(mc.account_guid)) {
        mortgageByAccount.set(mc.account_guid, (mc.config ?? {}) as MortgageToolConfig);
      }
    }

    const debts = rows.map((row) => {
      const rawBalance = row.balance ?? 0;
      // Liabilities are credit-balance (negative) in GnuCash; owed = -raw.
      const owed = round2(-rawBalance);

      const savedDebt = savedDebts[row.guid];
      const mortgage = mortgageByAccount.get(row.guid);

      let apr = 0;
      let minPayment = 0;
      let source: 'saved' | 'mortgage' | 'default' = 'default';

      if (mortgage) {
        if (typeof mortgage.interestRate === 'number') apr = round2(mortgage.interestRate);
        const payment = amortizedMonthlyPayment(
          mortgage.originalAmount ?? 0,
          mortgage.interestRate ?? 0,
          mortgage.loanTermMonths ?? 0
        );
        if (payment !== null) minPayment = round2(payment);
        source = 'mortgage';
      }
      if (savedDebt) {
        if (typeof savedDebt.apr === 'number') apr = savedDebt.apr;
        if (typeof savedDebt.minPayment === 'number') minPayment = savedDebt.minPayment;
        source = 'saved';
      }

      return {
        guid: row.guid,
        name: row.name,
        accountType: row.account_type,
        currency: row.currency ?? 'USD',
        balance: owed,
        rawBalance: round2(rawBalance),
        apr,
        minPayment,
        include: savedDebt?.include ?? owed > 0,
        source,
      };
    });

    return NextResponse.json({
      debts,
      settings: {
        extraMonthly: saved.settings?.extraMonthly ?? 0,
        strategy: saved.settings?.strategy ?? 'avalanche',
      },
    });
  } catch (error) {
    console.error('Error loading debt payoff data:', error);
    return NextResponse.json({ error: 'Failed to load debt payoff data' }, { status: 500 });
  }
}

const PutSchema = z.object({
  debts: z.record(
    z.string().regex(/^[0-9a-f]{32}$/),
    z.object({
      apr: z.number().min(0).max(100),
      minPayment: z.number().min(0),
      include: z.boolean(),
    })
  ),
  settings: z.object({
    extraMonthly: z.number().min(0),
    strategy: z.enum(['snowball', 'avalanche']),
  }),
});

/**
 * PUT /api/tools/debt-payoff
 *
 * Saves per-debt config {apr, minPayment, include} keyed by account GUID and
 * planner settings {extraMonthly, strategy} into gnucash_web_tool_config
 * (tool_type 'debt-payoff', one row per user+book).
 */
export async function PUT(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const body = await request.json();
    const validated = PutSchema.parse(body);

    const config = { debts: validated.debts, settings: validated.settings };

    const existing = await loadSavedConfig(user.id, bookGuid);
    let savedRow;
    if (existing) {
      savedRow = await prisma.gnucash_web_tool_config.update({
        where: { id: existing.id },
        data: { config, updated_at: new Date() },
      });
    } else {
      savedRow = await prisma.gnucash_web_tool_config.create({
        data: {
          user_id: user.id,
          book_guid: bookGuid,
          tool_type: TOOL_TYPE,
          name: CONFIG_NAME,
          config,
        },
      });
    }

    return NextResponse.json({ id: savedRow.id, config: savedRow.config });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    console.error('Error saving debt payoff config:', error);
    return NextResponse.json({ error: 'Failed to save debt payoff config' }, { status: 500 });
  }
}

const ComputeSchema = z.object({
  debts: z
    .array(
      z.object({
        guid: z.string().min(1).max(64),
        name: z.string().min(1).max(255),
        balance: z.number().min(0).max(1e12),
        apr: z.number().min(0).max(100),
        minPayment: z.number().min(0).max(1e9),
      })
    )
    .min(1)
    .max(100),
  extraMonthly: z.number().min(0).max(1e9),
});

/**
 * POST /api/tools/debt-payoff
 *
 * Body: { debts: [{guid, name, balance, apr, minPayment}], extraMonthly }
 * Computes plans for BOTH strategies plus the minimum-payments-only baseline
 * and the comparison summary. Pure computation — nothing is persisted.
 */
export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    const validated = ComputeSchema.parse(body);

    const result = compareStrategies(validated.debts, validated.extraMonthly);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    console.error('Error computing debt payoff plans:', error);
    return NextResponse.json({ error: 'Failed to compute debt payoff plans' }, { status: 500 });
  }
}
