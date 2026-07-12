/**
 * Customer Summary report — per-customer sales, expenses, profit and markup
 * over a date range (GnuCash desktop's "Customer Summary" report).
 *
 * WHAT IS INCLUDED (documented because desktop semantics are subtle):
 *
 *   SALES — income-account splits on the posting transactions of posted
 *   documents whose effective owner resolves to a customer (owner_type 2
 *   directly, or owner_type 3 job → the job's customer). Income splits are
 *   credits (negative), so they are negated to read positive. Credit notes
 *   reduce sales naturally.
 *
 *   EXPENSES — expense-account splits on the posting transactions of posted
 *   documents attributable to the customer:
 *     1. documents whose effective owner IS the customer (rare: a customer
 *        document with expense lines), and
 *     2. documents CHARGED BACK to the customer via billto (billto_type 2 =
 *        customer directly, billto_type 3 = a job owned by the customer) —
 *        the GnuCash "Default Chargeback Project/Customer" on vendor bills
 *        and employee vouchers.
 *   When a document matches both, the owner attribution wins (counted once).
 *
 *   PROFIT = sales - expenses. MARKUP % = profit / expenses * 100 (null when
 *   the customer has no expenses). Customers with sales only ARE included.
 *
 * Book scoping follows the other business reports: posted documents are
 * scoped via post_acc ∈ the active book's account tree.
 *
 * Structure mirrors business-reports.ts: a PURE builder (unit-tested in
 * src/lib/__tests__/business-parity.test.ts) plus a SQL loader.
 */

import prisma from '@/lib/prisma';
import { OWNER_TYPE_CUSTOMER, OWNER_TYPE_JOB } from './business-reports';

/* ------------------------------------------------------------------ */
/* Pure                                                                 */
/* ------------------------------------------------------------------ */

/** One raw per-customer, per-account-type flow row from the loader. */
export interface RawCustomerFlowRow {
    customerGuid: string;
    customerName: string;
    accountType: 'INCOME' | 'EXPENSE';
    /** Raw split-value sum (income negative for revenue, expenses positive). */
    amount: number;
}

export interface CustomerSummaryRow {
    customerGuid: string;
    customerName: string;
    sales: number;
    expenses: number;
    profit: number;
    /** profit / expenses * 100; null when expenses are ~0. */
    markupPercent: number | null;
}

export interface CustomerSummaryReport {
    startDate: string;
    endDate: string;
    rows: CustomerSummaryRow[];
    totals: {
        sales: number;
        expenses: number;
        profit: number;
        markupPercent: number | null;
    };
}

const TOLERANCE = 0.005;

function round2(n: number): number {
    const r = Math.round(n * 100) / 100;
    return r === 0 ? 0 : r; // normalize -0
}

function round1(n: number): number {
    return Math.round(n * 10) / 10;
}

export function markupPercent(profit: number, expenses: number): number | null {
    if (Math.abs(expenses) < TOLERANCE) return null;
    return round1((profit / expenses) * 100);
}

/**
 * Aggregate raw flow rows into the per-customer summary, sorted by profit
 * (highest first). Pure. Customers whose sales AND expenses are both ~0 are
 * dropped; everyone else — including sales-only customers — is kept.
 */
export function buildCustomerSummary(
    rows: ReadonlyArray<RawCustomerFlowRow>,
): Pick<CustomerSummaryReport, 'rows' | 'totals'> {
    const byCustomer = new Map<string, CustomerSummaryRow>();

    for (const row of rows) {
        let entry = byCustomer.get(row.customerGuid);
        if (!entry) {
            entry = {
                customerGuid: row.customerGuid,
                customerName: row.customerName,
                sales: 0,
                expenses: 0,
                profit: 0,
                markupPercent: null,
            };
            byCustomer.set(row.customerGuid, entry);
        }
        if (row.accountType === 'INCOME') {
            // Income splits are credits (negative) — negate to read positive.
            entry.sales = round2(entry.sales - row.amount);
        } else {
            entry.expenses = round2(entry.expenses + row.amount);
        }
    }

    const result: CustomerSummaryRow[] = [];
    let totalSales = 0;
    let totalExpenses = 0;
    for (const entry of byCustomer.values()) {
        if (Math.abs(entry.sales) < TOLERANCE && Math.abs(entry.expenses) < TOLERANCE) continue;
        entry.profit = round2(entry.sales - entry.expenses);
        entry.markupPercent = markupPercent(entry.profit, entry.expenses);
        totalSales = round2(totalSales + entry.sales);
        totalExpenses = round2(totalExpenses + entry.expenses);
        result.push(entry);
    }

    result.sort((a, b) => b.profit - a.profit || a.customerName.localeCompare(b.customerName));

    const totalProfit = round2(totalSales - totalExpenses);
    return {
        rows: result,
        totals: {
            sales: totalSales,
            expenses: totalExpenses,
            profit: totalProfit,
            markupPercent: markupPercent(totalProfit, totalExpenses),
        },
    };
}

/* ------------------------------------------------------------------ */
/* SQL loader                                                           */
/* ------------------------------------------------------------------ */

/**
 * Load raw per-customer income/expense flows for the range. One CTE resolves
 * each posted document's effective owner and effective billto (jobs resolved
 * to their owner); income splits attribute to the owner customer, expense
 * splits to the owner customer first, else to the billto customer.
 */
export async function loadCustomerFlows(
    startDate: string,
    endDate: string,
    bookAccountGuids: string[],
): Promise<RawCustomerFlowRow[]> {
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T23:59:59.999Z`);

    const rows = await prisma.$queryRaw<
        { customer_guid: string; customer_name: string; account_type: string; amount: number }[]
    >`
        WITH docs AS (
            SELECT
                i.post_txn,
                CASE WHEN i.owner_type = ${OWNER_TYPE_JOB} THEN oj.owner_type ELSE i.owner_type END AS eff_owner_type,
                CASE WHEN i.owner_type = ${OWNER_TYPE_JOB} THEN oj.owner_guid ELSE i.owner_guid END AS eff_owner_guid,
                CASE WHEN i.billto_type = ${OWNER_TYPE_JOB} THEN bj.owner_type ELSE i.billto_type END AS eff_billto_type,
                CASE WHEN i.billto_type = ${OWNER_TYPE_JOB} THEN bj.owner_guid ELSE i.billto_guid END AS eff_billto_guid
            FROM invoices i
            LEFT JOIN jobs oj ON i.owner_type = ${OWNER_TYPE_JOB} AND oj.guid = i.owner_guid
            LEFT JOIN jobs bj ON i.billto_type = ${OWNER_TYPE_JOB} AND bj.guid = i.billto_guid
            WHERE i.post_txn IS NOT NULL
              AND i.post_acc = ANY(${bookAccountGuids}::text[])
        ),
        flows AS (
            SELECT
                CASE
                    WHEN a.account_type = 'INCOME' THEN
                        CASE WHEN d.eff_owner_type = ${OWNER_TYPE_CUSTOMER} THEN d.eff_owner_guid END
                    ELSE
                        CASE
                            WHEN d.eff_owner_type = ${OWNER_TYPE_CUSTOMER} THEN d.eff_owner_guid
                            WHEN d.eff_billto_type = ${OWNER_TYPE_CUSTOMER} THEN d.eff_billto_guid
                        END
                END AS customer_guid,
                a.account_type,
                s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric AS value
            FROM docs d
            JOIN transactions t ON t.guid = d.post_txn
            JOIN splits s ON s.tx_guid = d.post_txn
            JOIN accounts a ON a.guid = s.account_guid
            WHERE t.post_date >= ${start} AND t.post_date <= ${end}
              AND a.account_type IN ('INCOME', 'EXPENSE')
        )
        SELECT
            f.customer_guid,
            c.name AS customer_name,
            f.account_type,
            SUM(f.value)::float8 AS amount
        FROM flows f
        JOIN customers c ON c.guid = f.customer_guid
        WHERE f.customer_guid IS NOT NULL
        GROUP BY f.customer_guid, c.name, f.account_type
    `;

    return rows.map((r) => ({
        customerGuid: r.customer_guid,
        customerName: r.customer_name,
        accountType: r.account_type as 'INCOME' | 'EXPENSE',
        amount: r.amount,
    }));
}

/** Full customer summary report for the active book. */
export async function generateCustomerSummary(
    startDate: string,
    endDate: string,
    bookAccountGuids: string[],
): Promise<CustomerSummaryReport> {
    const rows = await loadCustomerFlows(startDate, endDate, bookAccountGuids);
    return { startDate, endDate, ...buildCustomerSummary(rows) };
}
