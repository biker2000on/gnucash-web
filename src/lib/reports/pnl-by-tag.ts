/**
 * P&L by Tag report
 *
 * Income and expense totals for a period grouped by the TRANSACTION's tags
 * (gnucash_web_transaction_tags joined through the book-scoped
 * gnucash_web_tags). Splits on INCOME/EXPENSE accounts are attributed to
 * every tag their transaction carries; transactions with no tag land in the
 * 'Untagged' bucket.
 *
 * COUNTING RULE (documented on the report too): a transaction with N tags
 * counts FULLY under each of its N tags — tags behave like overlapping
 * classes, not like an allocation. As a consequence the per-tag rows can sum
 * to MORE than the true period totals. The `totals` block is therefore
 * computed from an un-joined query (each split counted exactly once) and is
 * the number that matches the Income Statement.
 *
 * Sign convention: GnuCash stores income as negative; this report negates it
 * so income is positive. net = income - expenses.
 */

import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { ReportType, ReportFilters, ReportSection } from './types';

export interface PnlByTagRow {
    /** null for the Untagged bucket */
    tagId: number | null;
    tag: string;
    color: string | null;
    /** Sign-corrected: positive = income earned */
    income: number;
    /** Positive = money spent */
    expenses: number;
    /** income - expenses */
    net: number;
}

export interface PnlByTagData {
    type: ReportType.PNL_BY_TAG;
    title: string;
    generatedAt: string;
    filters: ReportFilters;
    rows: PnlByTagRow[];
    /** True period totals (each split counted once — see counting rule). */
    totals: { income: number; expenses: number; net: number };
    /** ReportData-compatible shape so ReportViewer CSV export works. */
    sections: ReportSection[];
    grandTotal: number;
}

export const UNTAGGED_LABEL = 'Untagged';

/** Raw aggregate row: one (tag, account_type) pair. */
export interface TagAggRow {
    tagId: number | null;
    tagName: string | null;
    tagColor: string | null;
    accountType: string;
    /** Raw signed sum of split quantities (GnuCash sign convention). */
    total: number;
}

/**
 * Pure bucketing: fold (tag, account_type) aggregates into per-tag rows with
 * sign-corrected income (positive) and expenses. Rows are sorted by tag name
 * with Untagged last; zero-activity rows are dropped.
 */
export function bucketPnlByTag(rows: TagAggRow[]): PnlByTagRow[] {
    const byKey = new Map<string, PnlByTagRow>();
    for (const r of rows) {
        const key = r.tagId === null ? '∅' : String(r.tagId);
        let row = byKey.get(key);
        if (!row) {
            row = {
                tagId: r.tagId,
                tag: r.tagId === null ? UNTAGGED_LABEL : (r.tagName ?? UNTAGGED_LABEL),
                color: r.tagId === null ? null : r.tagColor,
                income: 0,
                expenses: 0,
                net: 0,
            };
            byKey.set(key, row);
        }
        if (r.accountType === 'INCOME') {
            row.income += -r.total; // GnuCash stores income negative
        } else if (r.accountType === 'EXPENSE') {
            row.expenses += r.total;
        }
    }

    const result = [...byKey.values()]
        .map((r) => ({ ...r, net: r.income - r.expenses }))
        .filter((r) => r.income !== 0 || r.expenses !== 0);

    result.sort((a, b) => {
        if (a.tagId === null) return 1; // Untagged last
        if (b.tagId === null) return -1;
        return a.tag.localeCompare(b.tag);
    });
    return result;
}

export interface PnlByTagQuery {
    bookGuid: string;
    bookAccountGuids: string[];
    startDate: string | null;
    endDate: string | null;
}

export async function generatePnlByTag(query: PnlByTagQuery): Promise<PnlByTagData> {
    const now = new Date();
    const startDate = query.startDate
        ? new Date(query.startDate + 'T00:00:00Z')
        : new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const endDate = query.endDate ? new Date(query.endDate + 'T23:59:59Z') : now;

    const accountGuids = query.bookAccountGuids;
    const empty = accountGuids.length === 0;

    // Per-tag aggregates. A transaction carrying N book tags contributes each
    // of its P&L splits to all N tags (full amount each — see counting rule);
    // transactions with no book tag fall out of the LEFT JOIN as tag_id NULL.
    const aggRows = empty ? [] : await prisma.$queryRaw<Array<{
        tag_id: number | null;
        tag_name: string | null;
        tag_color: string | null;
        account_type: string;
        total: number;
    }>>(Prisma.sql`
        SELECT tg.id AS tag_id, tg.name AS tag_name, tg.color AS tag_color,
               a.account_type,
               COALESCE(SUM(s.quantity_num::numeric / NULLIF(s.quantity_denom, 0)::numeric), 0)::float8 AS total
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        JOIN accounts a ON a.guid = s.account_guid
        LEFT JOIN gnucash_web_transaction_tags tt
               ON tt.transaction_guid = t.guid
              AND tt.tag_id IN (SELECT id FROM gnucash_web_tags WHERE book_guid = ${query.bookGuid})
        LEFT JOIN gnucash_web_tags tg ON tg.id = tt.tag_id
        WHERE a.account_type IN ('INCOME', 'EXPENSE')
          AND a.guid = ANY(${accountGuids}::text[])
          AND t.post_date >= ${startDate} AND t.post_date <= ${endDate}
        GROUP BY tg.id, tg.name, tg.color, a.account_type
    `);

    const rows = bucketPnlByTag(aggRows.map((r) => ({
        tagId: r.tag_id === null ? null : Number(r.tag_id),
        tagName: r.tag_name,
        tagColor: r.tag_color,
        accountType: r.account_type,
        total: Number(r.total),
    })));

    // True totals: no tag join, so multi-tag transactions count exactly once.
    const totalRows = empty ? [] : await prisma.$queryRaw<Array<{
        account_type: string;
        total: number;
    }>>(Prisma.sql`
        SELECT a.account_type,
               COALESCE(SUM(s.quantity_num::numeric / NULLIF(s.quantity_denom, 0)::numeric), 0)::float8 AS total
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        JOIN accounts a ON a.guid = s.account_guid
        WHERE a.account_type IN ('INCOME', 'EXPENSE')
          AND a.guid = ANY(${accountGuids}::text[])
          AND t.post_date >= ${startDate} AND t.post_date <= ${endDate}
        GROUP BY a.account_type
    `);
    const incomeTotal = -Number(totalRows.find((r) => r.account_type === 'INCOME')?.total ?? 0);
    const expenseTotal = Number(totalRows.find((r) => r.account_type === 'EXPENSE')?.total ?? 0);

    const filters: ReportFilters = {
        startDate: query.startDate,
        endDate: query.endDate,
    };

    // ReportData-compatible sections so the shared CSV exporter works: one
    // section per tag with Income/Expenses items and the tag's net as total.
    const sections: ReportSection[] = rows.map((r) => ({
        title: r.tag,
        items: [
            { guid: `${r.tagId ?? 'untagged'}-income`, name: 'Income', amount: r.income },
            { guid: `${r.tagId ?? 'untagged'}-expenses`, name: 'Expenses', amount: r.expenses },
        ],
        total: r.net,
    }));

    return {
        type: ReportType.PNL_BY_TAG,
        title: 'P&L by Tag',
        generatedAt: new Date().toISOString(),
        filters,
        rows,
        totals: { income: incomeTotal, expenses: expenseTotal, net: incomeTotal - expenseTotal },
        sections,
        grandTotal: incomeTotal - expenseTotal,
    };
}
