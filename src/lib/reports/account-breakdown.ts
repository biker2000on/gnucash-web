import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';

/**
 * Account Breakdown chart report.
 *
 * Replaces the eight GnuCash desktop piechart/barchart variants
 * (Assets/Liabilities/Income/Expenses × Piechart/Barchart) with a single
 * report: aggregate balances (asset/liability: balance at end date;
 * income/expense: flow over the range) grouped by the ancestor account at a
 * chosen depth. Deeper accounts roll up into their depth-N ancestor and small
 * slices fold into an "Other" bucket.
 */

export type BreakdownAccountType = 'ASSET' | 'LIABILITY' | 'INCOME' | 'EXPENSE';

export interface BreakdownAccountNode {
    guid: string;
    name: string;
    parent_guid: string | null;
    account_type: string;
}

export interface BreakdownSlice {
    accountGuid: string;
    name: string;
    /** Full colon-separated account path (root excluded). */
    path: string;
    /** Positive magnitude (income and liability amounts are negated). */
    amount: number;
    /** True when the account has visible child accounts of the same class (drillable). */
    hasChildren: boolean;
    /** Only present on the synthetic "Other" bucket: the folded slices. */
    children?: BreakdownSlice[];
}

export interface AccountBreakdownData {
    type: BreakdownAccountType;
    depth: number;
    title: string;
    generatedAt: string;
    startDate: string | null;
    endDate: string | null;
    /** Drill-down subtree root, when drilled into a slice. */
    root: { guid: string; name: string; path: string } | null;
    slices: BreakdownSlice[];
    /** Sum of all slice amounts (including "Other"). */
    total: number;
}

export const OTHER_SLICE_GUID = '__other__';

/** GnuCash account types included in each breakdown class. */
export const BREAKDOWN_TYPE_ACCOUNT_TYPES: Record<BreakdownAccountType, string[]> = {
    ASSET: ['ASSET', 'BANK', 'CASH', 'STOCK', 'MUTUAL', 'RECEIVABLE'],
    LIABILITY: ['LIABILITY', 'CREDIT', 'PAYABLE'],
    INCOME: ['INCOME'],
    EXPENSE: ['EXPENSE'],
};

export const BREAKDOWN_TITLES: Record<BreakdownAccountType, string> = {
    ASSET: 'Assets',
    LIABILITY: 'Liabilities',
    INCOME: 'Income',
    EXPENSE: 'Expenses',
};

/**
 * Sign multiplier so every class displays positive magnitudes:
 * income splits are stored negative, liability balances are negative.
 */
const TYPE_SIGN: Record<BreakdownAccountType, number> = {
    ASSET: 1,
    LIABILITY: -1,
    INCOME: -1,
    EXPENSE: 1,
};

export interface ComputeBreakdownOptions {
    type: BreakdownAccountType;
    /** Grouping depth: 1-4 levels below the grouping root (top-level accounts = depth 1). */
    depth: number;
    /** Maximum number of slices including the "Other" bucket. Default 10. */
    maxSlices?: number;
    /** Slices under this share of the positive total fold into "Other". Default 0.01 (1%). */
    minShare?: number;
    /** Drill-down: group within this account's subtree instead of the whole class. */
    rootGuid?: string | null;
}

export interface ComputeBreakdownResult {
    slices: BreakdownSlice[];
    total: number;
    root: { guid: string; name: string; path: string } | null;
}

/**
 * Pure grouping core. `totals` holds the signed raw per-account split totals
 * (own splits only, no descendant rollup — the rollup happens here).
 */
export function computeAccountBreakdown(
    accounts: BreakdownAccountNode[],
    totals: Map<string, number>,
    options: ComputeBreakdownOptions,
): ComputeBreakdownResult {
    const { type, rootGuid } = options;
    const depth = Math.min(Math.max(Math.floor(options.depth) || 1, 1), 6);
    const maxSlices = Math.max(options.maxSlices ?? 10, 1);
    const minShare = options.minShare ?? 0.01;
    const sign = TYPE_SIGN[type];
    const typeSet = new Set(BREAKDOWN_TYPE_ACCOUNT_TYPES[type]);

    const byGuid = new Map(accounts.map(a => [a.guid, a]));
    const childrenOf = new Map<string, BreakdownAccountNode[]>();
    for (const a of accounts) {
        if (!a.parent_guid) continue;
        const list = childrenOf.get(a.parent_guid);
        if (list) list.push(a);
        else childrenOf.set(a.parent_guid, [a]);
    }

    const isTypeAccount = (a: BreakdownAccountNode) => typeSet.has(a.account_type);
    const typeChildren = (guid: string) => (childrenOf.get(guid) ?? []).filter(isTypeAccount);

    const fullPath = (guid: string): string => {
        const parts: string[] = [];
        let cur = byGuid.get(guid);
        let hops = 0;
        while (cur && cur.account_type !== 'ROOT' && hops++ < 32) {
            parts.unshift(cur.name);
            cur = cur.parent_guid ? byGuid.get(cur.parent_guid) : undefined;
        }
        return parts.join(':');
    };

    const root = rootGuid ? byGuid.get(rootGuid) ?? null : null;
    if (rootGuid && !root) {
        return { slices: [], total: 0, root: null };
    }

    // Level-1 grouping bases: children of the drill-down root, or the topmost
    // accounts of the requested class (accounts whose parent is not in the class).
    let bases: BreakdownAccountNode[];
    if (root) {
        bases = typeChildren(root.guid);
    } else {
        bases = accounts.filter(a => {
            if (!isTypeAccount(a)) return false;
            const parent = a.parent_guid ? byGuid.get(a.parent_guid) : undefined;
            return !parent || !isTypeAccount(parent);
        });
    }

    // Roll every account's own total up into its ancestor at the grouping depth.
    // Accounts at level <= depth form their own group (their own splits stay
    // theirs even when children become separate slices).
    const groupTotals = new Map<string, number>();
    const groupNodes = new Map<string, BreakdownAccountNode>();
    const visit = (acct: BreakdownAccountNode, level: number, anchor: BreakdownAccountNode) => {
        const groupNode = level <= depth ? acct : anchor;
        const own = totals.get(acct.guid) ?? 0;
        if (own !== 0) {
            groupTotals.set(groupNode.guid, (groupTotals.get(groupNode.guid) ?? 0) + own);
            groupNodes.set(groupNode.guid, groupNode);
        }
        for (const child of typeChildren(acct.guid)) {
            visit(child, level + 1, groupNode);
        }
    };
    for (const base of bases) visit(base, 1, base);

    // The drill-down root's own splits belong to no child subtree — surface them.
    if (root) {
        const own = totals.get(root.guid) ?? 0;
        if (own !== 0) {
            groupTotals.set(root.guid, (groupTotals.get(root.guid) ?? 0) + own);
            groupNodes.set(root.guid, root);
        }
    }

    const allSlices: BreakdownSlice[] = [];
    for (const [guid, raw] of groupTotals) {
        const amount = sign * raw;
        if (amount === 0) continue;
        const node = groupNodes.get(guid)!;
        allSlices.push({
            accountGuid: guid,
            name: node.name,
            path: fullPath(guid),
            amount,
            hasChildren: guid !== root?.guid && typeChildren(guid).length > 0,
        });
    }
    allSlices.sort((a, b) => b.amount - a.amount);

    // Fold small slices (and anything beyond maxSlices - 1) into "Other".
    const positiveTotal = allSlices.reduce((s, x) => s + (x.amount > 0 ? x.amount : 0), 0);
    const shareOf = (slice: BreakdownSlice) => (positiveTotal > 0 ? slice.amount / positiveTotal : 1);
    const kept: BreakdownSlice[] = [];
    const folded: BreakdownSlice[] = [];
    for (const slice of allSlices) {
        if (kept.length < maxSlices - 1 && shareOf(slice) >= minShare) kept.push(slice);
        else folded.push(slice);
    }
    if (folded.length === 1 && shareOf(folded[0]) >= minShare) {
        // Exactly maxSlices slices, none tiny — an "Other" of one is pointless.
        kept.push(folded[0]);
    } else if (folded.length > 0) {
        kept.push({
            accountGuid: OTHER_SLICE_GUID,
            name: 'Other',
            path: 'Other',
            amount: folded.reduce((s, x) => s + x.amount, 0),
            hasChildren: false,
            children: folded,
        });
    }

    const total = kept.reduce((s, x) => s + x.amount, 0);
    return {
        slices: kept,
        total,
        root: root ? { guid: root.guid, name: root.name, path: fullPath(root.guid) } : null,
    };
}

export interface GenerateAccountBreakdownParams {
    type: BreakdownAccountType;
    depth: number;
    startDate: string | null;
    endDate: string | null;
    maxSlices?: number;
    rootGuid?: string | null;
    bookAccountGuids: string[];
}

/**
 * Fetch account tree + per-account split totals and run the grouping core.
 *
 * Asset/liability amounts are point-in-time balances (all splits up to the
 * end date); income/expense amounts are flows over [startDate, endDate].
 * STOCK/MUTUAL accounts use split value (cash cost, in transaction currency)
 * instead of quantity (shares).
 */
export async function generateAccountBreakdown(
    params: GenerateAccountBreakdownParams,
): Promise<AccountBreakdownData> {
    const { type, depth, startDate, endDate, maxSlices, rootGuid, bookAccountGuids } = params;

    const accounts = await prisma.accounts.findMany({
        where: {
            guid: { in: bookAccountGuids },
            OR: [{ hidden: 0 }, { hidden: null }],
        },
        select: { guid: true, name: true, parent_guid: true, account_type: true },
    });

    const typeSet = new Set(BREAKDOWN_TYPE_ACCOUNT_TYPES[type]);
    const typeGuids = accounts.filter(a => typeSet.has(a.account_type)).map(a => a.guid);

    const totals = new Map<string, number>();
    if (typeGuids.length > 0) {
        const isFlow = type === 'INCOME' || type === 'EXPENSE';
        const end = endDate ? new Date(endDate + 'T23:59:59Z') : new Date();
        const start = isFlow && startDate ? new Date(startDate + 'T00:00:00Z') : null;
        const startCond = start ? Prisma.sql`AND t.post_date >= ${start}` : Prisma.empty;

        const rows = await prisma.$queryRaw<Array<{ guid: string; total: number | null }>>(Prisma.sql`
            SELECT s.account_guid AS guid,
                   SUM(CASE WHEN a.account_type IN ('STOCK', 'MUTUAL')
                            THEN s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric
                            ELSE s.quantity_num::numeric / NULLIF(s.quantity_denom, 0)::numeric
                       END)::float8 AS total
            FROM splits s
            JOIN accounts a ON a.guid = s.account_guid
            JOIN transactions t ON t.guid = s.tx_guid
            WHERE s.account_guid = ANY(${typeGuids})
              AND t.post_date <= ${end}
              ${startCond}
            GROUP BY s.account_guid
        `);
        for (const row of rows) {
            totals.set(row.guid, Number(row.total ?? 0));
        }
    }

    const { slices, total, root } = computeAccountBreakdown(accounts, totals, {
        type,
        depth,
        maxSlices,
        rootGuid,
    });

    return {
        type,
        depth,
        title: `${BREAKDOWN_TITLES[type]} Breakdown`,
        generatedAt: new Date().toISOString(),
        startDate,
        endDate,
        root,
        slices,
        total,
    };
}
