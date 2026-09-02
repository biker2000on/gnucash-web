/**
 * QuickBooks → GnuCash account tree (pure — no database access).
 *
 * QuickBooks keeps a flat chart where every account carries an "Account
 * type" (Bank, Other Current Assets, Credit Card, Expenses, ...). GnuCash
 * books are trees whose top level is the five fundamental types. This module
 * turns the QBO Chart of Accounts into that shape:
 *
 *   Assets                      (placeholder)
 *     Current Assets            ← Bank, Accounts receivable, Other Current Assets
 *     Fixed Assets              ← Fixed Assets
 *     Other Assets              ← Other Assets
 *   Liabilities                 (placeholder)
 *     Current Liabilities       ← Accounts payable, Other Current Liabilities
 *     Credit Cards              ← Credit Card
 *     Long-Term Liabilities     ← Long Term Liabilities
 *   Equity                      ← Equity
 *   Income                      ← Income
 *     Other Income              ← Other Income
 *   Expenses                    ← Expenses
 *     Cost of Goods Sold        ← Cost of Goods Sold
 *     Other Expenses            ← Other Expense
 *
 * Rules:
 *   - The QBO account TYPE decides the group; the account's own colon path
 *     is nested underneath it unchanged ("Payroll Liabilities:401K" →
 *     Liabilities:Current Liabilities:Payroll Liabilities:401K).
 *   - The GnuCash account_type is coerced from the group (Bank → BANK,
 *     Credit Card → CREDIT, ...) so children always agree with their parent;
 *     the QBO "Detail type" only refines within a group (Cash on hand → CASH).
 *   - Every CoA account is created, transacted on or not — the chart is the
 *     deliverable, not just the accounts the journal happens to touch.
 *   - A top-level QBO account that shares its group's name ("Cost of Goods
 *     Sold", "Other Expenses") BECOMES the group node instead of nesting a
 *     second level with the same name.
 *   - Journal accounts missing from the chart (QBO exports deleted accounts
 *     as "Name (deleted)") are matched without the suffix, else nested under
 *     their CoA parent when the parent exists, else placed in the group that
 *     fits their resolved GnuCash type.
 */

import { generateGuid } from '@/lib/gnucash';
import {
    canonicalAccountPath,
    normHeader,
    type QboCoaParseResult,
    type ResolvedAccount,
} from './qbo-journal';

export interface TreeNode {
    guid: string;
    name: string;
    /** Full GnuCash colon path from the book root */
    path: string;
    parentPath: string | null;
    accountType: string;
    placeholder: boolean;
    /** Where this node came from */
    origin: 'scaffold' | 'coa' | 'journal';
    /** Depth-first creation order guarantees parents precede children */
}

export interface AccountTree {
    /** Parents precede children */
    nodes: TreeNode[];
    /** Journal account path (as it appears in the export) → node guid */
    guidByJournalPath: Map<string, string>;
    /** Journal account path → full GnuCash path it imports as */
    targetPathByJournalPath: Map<string, string>;
    /** Journal accounts that were NOT in the chart and how they were placed */
    unmatched: Array<{ path: string; placedAs: string; how: 'deleted-suffix' | 'parent' | 'type' }>;
    /** CoA accounts created (whether or not the journal touches them) */
    coaAccountCount: number;
}

/* ------------------------------------------------------------------ */
/* Scaffold                                                             */
/* ------------------------------------------------------------------ */

interface Group {
    /** Scaffold path segments the accounts nest under */
    segments: string[];
    /** GnuCash type coerced onto accounts in this group */
    type: string;
}

const SCAFFOLD: Array<{ path: string[]; type: string }> = [
    { path: ['Assets'], type: 'ASSET' },
    { path: ['Assets', 'Current Assets'], type: 'ASSET' },
    { path: ['Assets', 'Fixed Assets'], type: 'ASSET' },
    { path: ['Assets', 'Other Assets'], type: 'ASSET' },
    { path: ['Liabilities'], type: 'LIABILITY' },
    { path: ['Liabilities', 'Current Liabilities'], type: 'LIABILITY' },
    { path: ['Liabilities', 'Credit Cards'], type: 'CREDIT' },
    { path: ['Liabilities', 'Long-Term Liabilities'], type: 'LIABILITY' },
    { path: ['Equity'], type: 'EQUITY' },
    { path: ['Income'], type: 'INCOME' },
    { path: ['Income', 'Other Income'], type: 'INCOME' },
    { path: ['Expenses'], type: 'EXPENSE' },
    { path: ['Expenses', 'Cost of Goods Sold'], type: 'EXPENSE' },
    { path: ['Expenses', 'Other Expenses'], type: 'EXPENSE' },
];

/** QBO "Account type" (and statement section labels) → group. Keys normalized. */
const GROUP_BY_QBO_TYPE: Record<string, Group> = {
    bank: { segments: ['Assets', 'Current Assets'], type: 'BANK' },
    'bank accounts': { segments: ['Assets', 'Current Assets'], type: 'BANK' },
    'accounts receivable (a/r)': { segments: ['Assets', 'Current Assets'], type: 'RECEIVABLE' },
    'accounts receivable': { segments: ['Assets', 'Current Assets'], type: 'RECEIVABLE' },
    'other current assets': { segments: ['Assets', 'Current Assets'], type: 'ASSET' },
    'other current asset': { segments: ['Assets', 'Current Assets'], type: 'ASSET' },
    'current assets': { segments: ['Assets', 'Current Assets'], type: 'ASSET' },
    'fixed assets': { segments: ['Assets', 'Fixed Assets'], type: 'ASSET' },
    'fixed asset': { segments: ['Assets', 'Fixed Assets'], type: 'ASSET' },
    'other assets': { segments: ['Assets', 'Other Assets'], type: 'ASSET' },
    'other asset': { segments: ['Assets', 'Other Assets'], type: 'ASSET' },
    'accounts payable (a/p)': { segments: ['Liabilities', 'Current Liabilities'], type: 'PAYABLE' },
    'accounts payable': { segments: ['Liabilities', 'Current Liabilities'], type: 'PAYABLE' },
    'credit card': { segments: ['Liabilities', 'Credit Cards'], type: 'CREDIT' },
    'credit cards': { segments: ['Liabilities', 'Credit Cards'], type: 'CREDIT' },
    'other current liabilities': { segments: ['Liabilities', 'Current Liabilities'], type: 'LIABILITY' },
    'other current liability': { segments: ['Liabilities', 'Current Liabilities'], type: 'LIABILITY' },
    'current liabilities': { segments: ['Liabilities', 'Current Liabilities'], type: 'LIABILITY' },
    'long term liabilities': { segments: ['Liabilities', 'Long-Term Liabilities'], type: 'LIABILITY' },
    'long-term liabilities': { segments: ['Liabilities', 'Long-Term Liabilities'], type: 'LIABILITY' },
    'long term liability': { segments: ['Liabilities', 'Long-Term Liabilities'], type: 'LIABILITY' },
    'long-term liability': { segments: ['Liabilities', 'Long-Term Liabilities'], type: 'LIABILITY' },
    equity: { segments: ['Equity'], type: 'EQUITY' },
    income: { segments: ['Income'], type: 'INCOME' },
    revenue: { segments: ['Income'], type: 'INCOME' },
    'other income': { segments: ['Income', 'Other Income'], type: 'INCOME' },
    'cost of goods sold': { segments: ['Expenses', 'Cost of Goods Sold'], type: 'EXPENSE' },
    'cost of sales': { segments: ['Expenses', 'Cost of Goods Sold'], type: 'EXPENSE' },
    cogs: { segments: ['Expenses', 'Cost of Goods Sold'], type: 'EXPENSE' },
    expenses: { segments: ['Expenses'], type: 'EXPENSE' },
    expense: { segments: ['Expenses'], type: 'EXPENSE' },
    'other expense': { segments: ['Expenses', 'Other Expenses'], type: 'EXPENSE' },
    'other expenses': { segments: ['Expenses', 'Other Expenses'], type: 'EXPENSE' },
};

/** Fallback when only a GnuCash type is known (journal-only accounts, overrides). */
const GROUP_BY_GNUCASH_TYPE: Record<string, Group> = {
    BANK: { segments: ['Assets', 'Current Assets'], type: 'BANK' },
    CASH: { segments: ['Assets', 'Current Assets'], type: 'CASH' },
    ASSET: { segments: ['Assets', 'Current Assets'], type: 'ASSET' },
    RECEIVABLE: { segments: ['Assets', 'Current Assets'], type: 'RECEIVABLE' },
    STOCK: { segments: ['Assets', 'Current Assets'], type: 'STOCK' },
    MUTUAL: { segments: ['Assets', 'Current Assets'], type: 'MUTUAL' },
    PAYABLE: { segments: ['Liabilities', 'Current Liabilities'], type: 'PAYABLE' },
    CREDIT: { segments: ['Liabilities', 'Credit Cards'], type: 'CREDIT' },
    LIABILITY: { segments: ['Liabilities', 'Current Liabilities'], type: 'LIABILITY' },
    EQUITY: { segments: ['Equity'], type: 'EQUITY' },
    INCOME: { segments: ['Income'], type: 'INCOME' },
    EXPENSE: { segments: ['Expenses'], type: 'EXPENSE' },
};

const DELETED_SUFFIX = /\s*\(deleted\)\s*$/i;

/**
 * Resolve the group for a QBO account type string. Statement-derived charts
 * carry the section path ("ASSETS › Current Assets › Bank Accounts"); the
 * innermost recognizable section wins.
 */
export function groupForQboType(qboType: string): Group | null {
    const parts = qboType.split('›').map((p) => normHeader(p)).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
        const g = GROUP_BY_QBO_TYPE[parts[i]];
        if (g) return g;
    }
    return null;
}

/** Detail-type refinements that stay inside the group's fundamental type. */
function refineType(groupType: string, detailType: string): string {
    const d = normHeader(detailType);
    if (groupType === 'BANK' && (d === 'cash on hand' || d === 'cash')) return 'CASH';
    return groupType;
}

/* ------------------------------------------------------------------ */
/* Builder                                                              */
/* ------------------------------------------------------------------ */

/**
 * Build the scaffolded tree.
 *
 * @param resolved  journal accounts with their resolved GnuCash types (UI
 *                  overrides already applied)
 * @param coa       the chart (CSV upload or statement-derived); null → every
 *                  journal account is placed by its resolved type
 */
export function buildScaffoldedTree(
    resolved: ResolvedAccount[],
    coa: QboCoaParseResult | null
): AccountTree {
    const nodes: TreeNode[] = [];
    const byPath = new Map<string, TreeNode>(); // lower-cased full path → node
    const resolvedByPath = new Map(resolved.map((r) => [r.path.toLowerCase(), r]));

    const addNode = (
        segments: string[],
        accountType: string,
        placeholder: boolean,
        origin: TreeNode['origin']
    ): TreeNode => {
        const path = segments.join(':');
        const existing = byPath.get(path.toLowerCase());
        if (existing) return existing;
        const node: TreeNode = {
            guid: generateGuid(),
            name: segments[segments.length - 1],
            path,
            parentPath: segments.length > 1 ? segments.slice(0, -1).join(':') : null,
            accountType,
            placeholder,
            origin,
        };
        nodes.push(node);
        byPath.set(path.toLowerCase(), node);
        return node;
    };

    // 1. Scaffold — placeholders; pruned at the end if nothing landed in them.
    for (const s of SCAFFOLD) addNode(s.path, s.type, true, 'scaffold');

    // 2. Chart accounts: group by QBO type, nest the QBO path under the group.
    //    Parents first (shorter paths) so a child can find its parent node.
    const qboToNode = new Map<string, TreeNode>(); // lower-cased QBO path → node
    let coaAccountCount = 0; // chart rows placed (synthesized parents excluded)
    const coaAccounts = [...(coa?.accounts ?? [])].sort(
        (a, b) => a.fullName.split(':').length - b.fullName.split(':').length
    );
    for (const a of coaAccounts) {
        const qboPath = canonicalAccountPath(a.fullName);
        if (!qboPath) continue;
        const key = qboPath.toLowerCase();
        if (qboToNode.has(key)) continue;

        const segments = qboPath.split(':');
        const override = resolvedByPath.get(key);
        const group =
            groupForQboType(a.qboType) ??
            GROUP_BY_GNUCASH_TYPE[a.gnucashType ?? override?.gnucashType ?? 'ASSET'] ??
            GROUP_BY_GNUCASH_TYPE.ASSET;

        let node: TreeNode;
        if (segments.length === 1) {
            const groupPath = group.segments.join(':');
            const groupNode = byPath.get(groupPath.toLowerCase())!;
            if (normHeader(segments[0]) === normHeader(groupNode.name)) {
                // "Cost of Goods Sold" the account IS "Cost of Goods Sold" the group.
                node = groupNode;
                node.origin = 'coa';
                node.placeholder = false;
            } else {
                node = addNode(
                    [...group.segments, segments[0]],
                    override?.source === 'override' ? override.gnucashType : refineType(group.type, a.detailType),
                    false,
                    'coa'
                );
            }
        } else {
            // Walk down from the deepest chart ancestor that exists; synthesize
            // any missing intermediate parents inside the group (a chart export
            // can omit a parent row while listing its children).
            let base: string[] | null = null;
            let from = segments.length - 1;
            for (; from > 0; from--) {
                const anc = qboToNode.get(segments.slice(0, from).join(':').toLowerCase());
                if (anc) {
                    base = anc.path.split(':');
                    break;
                }
            }
            if (base === null) base = [...group.segments];
            for (let i = from; i < segments.length - 1; i++) {
                base = [...base, segments[i]];
                const made = addNode(base, group.type, false, 'coa');
                qboToNode.set(segments.slice(0, i + 1).join(':').toLowerCase(), made);
            }
            node = addNode(
                [...base, segments[segments.length - 1]],
                override?.source === 'override' ? override.gnucashType : refineType(group.type, a.detailType),
                false,
                'coa'
            );
        }
        qboToNode.set(key, node);
        coaAccountCount++;
    }

    // 3. Journal accounts not in the chart.
    const guidByJournalPath = new Map<string, string>();
    const targetPathByJournalPath = new Map<string, string>();
    const unmatched: AccountTree['unmatched'] = [];

    const placeJournalOnly = (r: ResolvedAccount): TreeNode => {
        const path = canonicalAccountPath(r.path);
        const segments = path.split(':');
        // a) "(deleted)" suffix stripped — the account still exists in the chart
        const stripped = canonicalAccountPath(path.replace(DELETED_SUFFIX, ''));
        if (stripped !== path) {
            const hit = qboToNode.get(stripped.toLowerCase());
            if (hit) {
                unmatched.push({ path: r.path, placedAs: hit.path, how: 'deleted-suffix' });
                return hit;
            }
        }
        // b) parent exists in the chart — nest under it, inheriting its type
        if (segments.length > 1) {
            const parent = qboToNode.get(segments.slice(0, -1).join(':').toLowerCase());
            if (parent) {
                const node = addNode(
                    [...parent.path.split(':'), segments[segments.length - 1]],
                    r.source === 'override' ? r.gnucashType : parent.accountType,
                    false,
                    'journal'
                );
                unmatched.push({ path: r.path, placedAs: node.path, how: 'parent' });
                return node;
            }
        }
        // c) by resolved GnuCash type
        const group = GROUP_BY_GNUCASH_TYPE[r.gnucashType] ?? GROUP_BY_GNUCASH_TYPE.ASSET;
        let base = group.segments;
        for (let i = 0; i < segments.length - 1; i++) {
            base = [...base, segments[i]];
            addNode(base, group.type, false, 'journal');
        }
        const node = addNode([...base, segments[segments.length - 1]], r.gnucashType, false, 'journal');
        unmatched.push({ path: r.path, placedAs: node.path, how: 'type' });
        return node;
    };

    for (const r of resolved) {
        const key = canonicalAccountPath(r.path).toLowerCase();
        let node = qboToNode.get(key);
        if (!node) {
            node = placeJournalOnly(r);
            qboToNode.set(key, node);
        }
        // A scaffold group that is transacted on directly is a real account.
        if (node.origin === 'scaffold') {
            node.origin = 'journal';
            node.placeholder = false;
        }
        guidByJournalPath.set(r.path, node.guid);
        targetPathByJournalPath.set(r.path, node.path);
    }

    // 4. Prune empty scaffold placeholders (e.g. no Other Assets in this chart).
    const hasChild = new Set<string>();
    for (const n of nodes) if (n.parentPath) hasChild.add(n.parentPath.toLowerCase());
    let changed = true;
    while (changed) {
        changed = false;
        for (let i = nodes.length - 1; i >= 0; i--) {
            const n = nodes[i];
            if (n.origin === 'scaffold' && !hasChild.has(n.path.toLowerCase())) {
                nodes.splice(i, 1);
                byPath.delete(n.path.toLowerCase());
                // Recompute child presence for the parent.
                hasChild.clear();
                for (const m of nodes) if (m.parentPath) hasChild.add(m.parentPath.toLowerCase());
                changed = true;
            }
        }
    }

    return { nodes, guidByJournalPath, targetPathByJournalPath, unmatched, coaAccountCount };
}
