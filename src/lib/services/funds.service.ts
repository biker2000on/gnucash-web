/**
 * Restricted Funds service — nonprofit-style fund tracking.
 *
 * Funds (gnucash_web_funds) carry a donor-restriction class; GnuCash accounts
 * are assigned to funds via gnucash_web_account_funds (one fund per account).
 * The fund report buckets per-account activity into per-fund rows:
 *
 *   - income / expense / net for the requested period (INCOME and EXPENSE
 *     accounts only, sign-corrected so both read positive), and
 *   - net assets to date: ALL splits through the end date for the fund's
 *     accounts, sign-normalized by natural balance (credit-natural account
 *     types are negated) so income raises and expenses lower net assets.
 *
 * Accounts not assigned to any fund land in an 'Unassigned' bucket
 * (income/expense accounts only, so the whole balance sheet doesn't get
 * dumped into it).
 *
 * Recommended assignment model: assign INCOME and EXPENSE accounts to funds.
 * Assigning balance-sheet accounts too will double count (their balances
 * already reflect the income/expense flows).
 */

import prisma from '@/lib/prisma';
import { getAccountGuidsForBook } from '@/lib/book-scope';

/** Caller-fixable input problem — HTTP 400. */
export class FundValidationError extends Error {}
/** Missing entity — HTTP 404. */
export class FundNotFoundError extends Error {}
/** Valid request, wrong state (e.g. deleting a fund with accounts) — HTTP 409. */
export class FundStateError extends Error {}

export const FUND_RESTRICTIONS = [
    'unrestricted',
    'temporarily_restricted',
    'permanently_restricted',
] as const;
export type FundRestriction = (typeof FUND_RESTRICTIONS)[number];

export function isFundRestriction(value: unknown): value is FundRestriction {
    return typeof value === 'string' && (FUND_RESTRICTIONS as readonly string[]).includes(value);
}

/** Account types whose raw split sums are credit-natural (negated for display). */
const CREDIT_NATURAL_TYPES = new Set(['INCOME', 'EXPENSE', 'EQUITY']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FundView {
    id: number;
    name: string;
    restriction: FundRestriction;
    description: string | null;
    active: boolean;
    sortOrder: number;
    accountGuids: string[];
}

export interface FundInput {
    name: string;
    restriction?: FundRestriction;
    description?: string | null;
    active?: boolean;
    sortOrder?: number;
}

/** Per-account activity row fed to the pure report builder. */
export interface FundAccountActivityRow {
    accountGuid: string;
    accountType: string;
    /** Raw split-quantity sum for the report period (GnuCash signs). */
    periodSum: number;
    /** Raw split-quantity sum for all time through the end date. */
    toDateSum: number;
}

export interface FundReportRow {
    /** null for the Unassigned bucket. */
    fundId: number | null;
    name: string;
    restriction: FundRestriction | null;
    active: boolean;
    /** Period income, sign-corrected positive. */
    income: number;
    /** Period expense, positive. */
    expense: number;
    /** income - expense. */
    net: number;
    /** Net assets to date (see module doc for the sign rule). */
    netAssets: number;
    accountCount: number;
}

export interface FundReport {
    startDate: string | null;
    endDate: string | null;
    rows: FundReportRow[];
    totals: { income: number; expense: number; net: number; netAssets: number };
}

// ---------------------------------------------------------------------------
// Pure — report building
// ---------------------------------------------------------------------------

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

export interface FundForReport {
    id: number;
    name: string;
    restriction: string;
    active: boolean;
    sortOrder: number;
}

/**
 * Bucket per-account activity into per-fund report rows. Pure.
 *
 * `assignments` maps accountGuid → fundId. Accounts without an assignment
 * fall into the 'Unassigned' bucket (only INCOME/EXPENSE rows should be
 * passed for unassigned accounts — the loader enforces that).
 *
 * Sign handling (GnuCash raw sums):
 *   income period sums are credits (negative)  → income = -periodSum
 *   expense period sums are debits (positive)  → expense = +periodSum
 *   net assets: credit-natural types (INCOME/EXPENSE/EQUITY) contribute
 *   -toDateSum; debit-natural types (assets, banks, ...) contribute +toDateSum.
 *   Liabilities keep their raw (negative) sums, reducing net assets.
 */
export function buildFundReport(
    funds: ReadonlyArray<FundForReport>,
    assignments: ReadonlyMap<string, number>,
    activity: ReadonlyArray<FundAccountActivityRow>,
    dates: { startDate: string | null; endDate: string | null },
): FundReport {
    interface Bucket {
        row: FundReportRow;
        seen: Set<string>;
    }
    const buckets = new Map<number | null, Bucket>();
    const makeBucket = (
        fundId: number | null,
        name: string,
        restriction: FundRestriction | null,
        active: boolean,
    ): Bucket => ({
        row: { fundId, name, restriction, active, income: 0, expense: 0, net: 0, netAssets: 0, accountCount: 0 },
        seen: new Set(),
    });

    for (const fund of funds) {
        buckets.set(
            fund.id,
            makeBucket(
                fund.id,
                fund.name,
                isFundRestriction(fund.restriction) ? fund.restriction : 'unrestricted',
                fund.active,
            ),
        );
    }
    const unassigned = makeBucket(null, 'Unassigned', null, true);
    buckets.set(null, unassigned);

    for (const row of activity) {
        const fundId = assignments.get(row.accountGuid) ?? null;
        const bucket = buckets.get(fundId) ?? unassigned;

        if (row.accountType === 'INCOME') {
            bucket.row.income += -row.periodSum;
        } else if (row.accountType === 'EXPENSE') {
            bucket.row.expense += row.periodSum;
        }

        const creditNatural = CREDIT_NATURAL_TYPES.has(row.accountType);
        bucket.row.netAssets += creditNatural ? -row.toDateSum : row.toDateSum;
        bucket.seen.add(row.accountGuid);
    }

    // Account counts: assigned counts come from the assignment map so empty
    // (no-activity) accounts still count; unassigned counts activity rows.
    const assignedCounts = new Map<number, number>();
    for (const fundId of assignments.values()) {
        assignedCounts.set(fundId, (assignedCounts.get(fundId) ?? 0) + 1);
    }

    const rows: FundReportRow[] = [];
    const orderedFunds = [...funds].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    );
    for (const fund of orderedFunds) {
        const bucket = buckets.get(fund.id)!;
        const r = bucket.row;
        r.income = round2(r.income);
        r.expense = round2(r.expense);
        r.net = round2(r.income - r.expense);
        r.netAssets = round2(r.netAssets);
        r.accountCount = assignedCounts.get(fund.id) ?? 0;
        // Inactive funds with no assignments and no numbers stay hidden.
        if (!fund.active && r.accountCount === 0 && r.income === 0 && r.expense === 0 && r.netAssets === 0) {
            continue;
        }
        rows.push(r);
    }

    const u = unassigned.row;
    u.income = round2(u.income);
    u.expense = round2(u.expense);
    u.net = round2(u.income - u.expense);
    u.netAssets = round2(u.netAssets);
    u.accountCount = unassigned.seen.size;
    if (u.accountCount > 0 || u.income !== 0 || u.expense !== 0 || u.netAssets !== 0) {
        rows.push(u);
    }

    const totals = {
        income: round2(rows.reduce((s, r) => s + r.income, 0)),
        expense: round2(rows.reduce((s, r) => s + r.expense, 0)),
        net: round2(rows.reduce((s, r) => s + r.net, 0)),
        netAssets: round2(rows.reduce((s, r) => s + r.netAssets, 0)),
    };

    return { startDate: dates.startDate, endDate: dates.endDate, rows, totals };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

type FundRow = NonNullable<Awaited<ReturnType<typeof prisma.gnucash_web_funds.findUnique>>>;

function toView(fund: FundRow, accountGuids: string[]): FundView {
    return {
        id: fund.id,
        name: fund.name,
        restriction: isFundRestriction(fund.restriction) ? fund.restriction : 'unrestricted',
        description: fund.description ?? null,
        active: fund.active,
        sortOrder: fund.sort_order,
        accountGuids,
    };
}

export async function listFunds(bookGuid: string): Promise<FundView[]> {
    const funds = await prisma.gnucash_web_funds.findMany({
        where: { book_guid: bookGuid },
        include: { account_funds: { select: { account_guid: true } } },
        orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
    });
    return funds.map((f) =>
        toView(f, f.account_funds.map((af: { account_guid: string }) => af.account_guid)),
    );
}

function validateFundInput(input: FundInput, partial = false): void {
    if (!partial || input.name !== undefined) {
        if (!input.name?.trim()) throw new FundValidationError('Fund name is required');
    }
    if (input.restriction !== undefined && !isFundRestriction(input.restriction)) {
        throw new FundValidationError(
            `Invalid restriction '${input.restriction}' — expected one of: ${FUND_RESTRICTIONS.join(', ')}`,
        );
    }
}

export async function createFund(bookGuid: string, input: FundInput): Promise<FundView> {
    validateFundInput(input);
    const fund = await prisma.gnucash_web_funds.create({
        data: {
            book_guid: bookGuid,
            name: input.name.trim(),
            restriction: input.restriction ?? 'unrestricted',
            description: input.description?.trim() || null,
            active: input.active ?? true,
            sort_order: input.sortOrder ?? 0,
        },
    });
    return toView(fund, []);
}

async function getFundChecked(bookGuid: string, fundId: number): Promise<FundRow> {
    const fund = await prisma.gnucash_web_funds.findUnique({ where: { id: fundId } });
    if (!fund || fund.book_guid !== bookGuid) {
        throw new FundNotFoundError(`Fund not found: ${fundId}`);
    }
    return fund;
}

export async function updateFund(
    bookGuid: string,
    fundId: number,
    input: Partial<FundInput>,
): Promise<FundView> {
    validateFundInput(input as FundInput, true);
    await getFundChecked(bookGuid, fundId);
    const fund = await prisma.gnucash_web_funds.update({
        where: { id: fundId },
        data: {
            name: input.name !== undefined ? input.name.trim() : undefined,
            restriction: input.restriction,
            description: input.description !== undefined ? input.description?.trim() || null : undefined,
            active: input.active,
            sort_order: input.sortOrder,
            updated_at: new Date(),
        },
        include: { account_funds: { select: { account_guid: true } } },
    });
    return toView(fund, fund.account_funds.map((af: { account_guid: string }) => af.account_guid));
}

export async function deleteFund(bookGuid: string, fundId: number): Promise<void> {
    await getFundChecked(bookGuid, fundId);
    const assigned = await prisma.gnucash_web_account_funds.count({ where: { fund_id: fundId } });
    if (assigned > 0) {
        throw new FundStateError(
            `Fund has ${assigned} assigned account(s). Unassign them first, or deactivate the fund instead of deleting it.`,
        );
    }
    await prisma.gnucash_web_funds.delete({ where: { id: fundId } });
}

/**
 * Replace-style account assignment: the given accounts become EXACTLY the
 * fund's accounts. Accounts previously on this fund but absent from the list
 * are unassigned; accounts assigned to other funds are moved here.
 */
export async function setAccountFunds(
    bookGuid: string,
    fundId: number,
    accountGuids: string[],
): Promise<FundView> {
    if (!Array.isArray(accountGuids)) {
        throw new FundValidationError('accountGuids must be an array');
    }
    const unique = Array.from(new Set(accountGuids.filter((g) => typeof g === 'string' && g)));

    const fund = await getFundChecked(bookGuid, fundId);

    if (unique.length > 0) {
        const bookGuids = new Set(await getAccountGuidsForBook(bookGuid));
        const outside = unique.filter((g) => !bookGuids.has(g));
        if (outside.length > 0) {
            throw new FundValidationError(
                `Account(s) not in the active book: ${outside.join(', ')}`,
            );
        }
    }

    await prisma.$transaction(async (tx) => {
        await tx.gnucash_web_account_funds.deleteMany({
            where: { OR: [{ fund_id: fundId }, { account_guid: { in: unique } }] },
        });
        if (unique.length > 0) {
            await tx.gnucash_web_account_funds.createMany({
                data: unique.map((account_guid) => ({ account_guid, fund_id: fundId })),
            });
        }
    });

    return toView(fund, unique);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export async function fundReport(
    bookGuid: string,
    opts: { startDate?: string | null; endDate?: string | null } = {},
): Promise<FundReport> {
    const startDate = opts.startDate || null;
    const endDate = opts.endDate || null;
    const start = startDate ? new Date(`${startDate}T00:00:00Z`) : new Date('1900-01-01T00:00:00Z');
    const end = endDate ? new Date(`${endDate}T23:59:59.999Z`) : new Date('9999-12-31T23:59:59Z');

    const bookAccountGuids = await getAccountGuidsForBook(bookGuid);
    if (bookAccountGuids.length === 0) {
        throw new FundNotFoundError(`Book not found: ${bookGuid}`);
    }

    const funds = await prisma.gnucash_web_funds.findMany({
        where: { book_guid: bookGuid },
    });
    const fundIds = funds.map((f) => f.id);
    const assignmentRows = fundIds.length
        ? await prisma.gnucash_web_account_funds.findMany({
              where: { fund_id: { in: fundIds }, account_guid: { in: bookAccountGuids } },
          })
        : [];
    const assignments = new Map(assignmentRows.map((a) => [a.account_guid, a.fund_id]));

    // Accounts feeding the report: every assigned account, plus the book's
    // unassigned INCOME/EXPENSE accounts (the 'Unassigned' bucket).
    const assignedGuids = Array.from(assignments.keys());
    const rows = await prisma.$queryRaw<
        { account_guid: string; account_type: string; period_sum: number; todate_sum: number }[]
    >`
        SELECT s.account_guid,
               a.account_type,
               COALESCE(SUM(
                   CASE WHEN t.post_date >= ${start} AND t.post_date <= ${end}
                        THEN s.quantity_num::numeric / NULLIF(s.quantity_denom, 0)::numeric
                        ELSE 0 END
               ), 0)::float8 AS period_sum,
               COALESCE(SUM(
                   CASE WHEN t.post_date <= ${end}
                        THEN s.quantity_num::numeric / NULLIF(s.quantity_denom, 0)::numeric
                        ELSE 0 END
               ), 0)::float8 AS todate_sum
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        JOIN accounts a ON a.guid = s.account_guid
        WHERE a.guid = ANY(${bookAccountGuids}::text[])
          AND (
              a.guid = ANY(${assignedGuids}::text[])
              OR a.account_type IN ('INCOME', 'EXPENSE')
          )
        GROUP BY s.account_guid, a.account_type
    `;

    const activity: FundAccountActivityRow[] = rows.map((r) => ({
        accountGuid: r.account_guid,
        accountType: r.account_type,
        periodSum: r.period_sum,
        toDateSum: r.todate_sum,
    }));

    return buildFundReport(
        funds.map((f) => ({
            id: f.id,
            name: f.name,
            restriction: f.restriction,
            active: f.active,
            sortOrder: f.sort_order,
        })),
        assignments,
        activity,
        { startDate, endDate },
    );
}
