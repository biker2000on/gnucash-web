/**
 * Customer Statements — activity over a period with running balance.
 *
 * Statement semantics (customer AR, GnuCash sign conventions):
 *   - Charges = POSTED customer invoices (post_txn set), dated by date_posted,
 *     amount = the invoice's posting total (+ increases what the customer owes).
 *   - Credits = payment transactions, amount = the sum applied to THIS
 *     customer's invoice lots (- decreases the balance). Job-owned invoices
 *     resolve to the end customer, matching `listPayments`.
 *   - openingBalance = sum(invoice totals posted BEFORE startDate)
 *                    - sum(payments dated BEFORE startDate).
 *     This is the open A/R carried into the period.
 *   - activity = date-ordered lines within [startDate, endDate], each with a
 *     running `balance` (opening + cumulative amounts). Invoices sort before
 *     payments on the same day.
 *   - closingBalance = openingBalance + sum(activity amounts).
 *   - aging = open amount per invoice AS OF endDate (total minus payments
 *     dated <= endDate), bucketed by days past the invoice due date relative
 *     to endDate (no due date => due at posting).
 *
 * Pure math is exported for unit tests; `getCustomerStatement` is the DB
 * loader built on the invoice engine's views.
 */

import prisma from '@/lib/prisma';
import {
  getInvoiceWithStatus,
  listPayments,
  OWNER_TYPE_CUSTOMER,
  OWNER_TYPE_JOB,
} from './invoice-engine';
import { roundCurrency } from './invoice-totals';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export interface StatementInvoiceInput {
  guid: string;
  /** Document number. */
  id: string;
  /** Posting date, ISO YYYY-MM-DD. */
  date: string;
  /** Posted total (A/R debit). */
  total: number;
  /** ISO due date; null => due at posting. */
  dueDate: string | null;
}

export interface StatementPaymentInput {
  txGuid: string;
  /** ISO payment date. */
  date: string;
  /** Check / reference number. */
  ref: string;
  /** Amount applied to this customer's invoices (positive). */
  amount: number;
  allocations: Array<{ invoiceGuid: string; amount: number }>;
}

export interface StatementLine {
  date: string;
  type: 'invoice' | 'payment';
  /** Invoice number or payment reference. */
  ref: string;
  /** Signed: +charge for invoices, -credit for payments. */
  amount: number;
  /** Running balance after this line. */
  balance: number;
}

export interface StatementAging {
  current: number;
  b1_30: number;
  b31_60: number;
  b61_90: number;
  b90plus: number;
  total: number;
}

export interface CustomerStatement {
  customer: {
    guid: string;
    id: string;
    name: string;
    currency: string;
    address: {
      name: string | null;
      addr1: string | null;
      addr2: string | null;
      addr3: string | null;
      addr4: string | null;
    };
  };
  period: { startDate: string | null; endDate: string };
  openingBalance: number;
  activity: StatementLine[];
  closingBalance: number;
  aging: StatementAging;
}

/* ------------------------------------------------------------------ */
/* Pure math (unit-tested, DB-free)                                     */
/* ------------------------------------------------------------------ */

/** Whole days from `fromIso` to `toIso` (positive when toIso is later). */
export function daysBetweenIso(fromIso: string, toIso: string): number {
  const from = Date.UTC(
    Number(fromIso.slice(0, 4)), Number(fromIso.slice(5, 7)) - 1, Number(fromIso.slice(8, 10)),
  );
  const to = Date.UTC(
    Number(toIso.slice(0, 4)), Number(toIso.slice(5, 7)) - 1, Number(toIso.slice(8, 10)),
  );
  return Math.round((to - from) / 86400000);
}

/**
 * Opening balance + running-balance activity + closing balance.
 * `startDate` null => opening balance 0 and activity from the beginning.
 */
export function buildStatementActivity(
  invoices: StatementInvoiceInput[],
  payments: StatementPaymentInput[],
  startDate: string | null,
  endDate: string,
): { openingBalance: number; activity: StatementLine[]; closingBalance: number } {
  let opening = 0;
  if (startDate) {
    for (const inv of invoices) {
      if (inv.date < startDate) opening += inv.total;
    }
    for (const pay of payments) {
      if (pay.date < startDate) opening -= pay.amount;
    }
  }
  opening = roundCurrency(opening);

  type Raw = { date: string; type: 'invoice' | 'payment'; ref: string; amount: number };
  const raw: Raw[] = [];
  for (const inv of invoices) {
    if ((startDate === null || inv.date >= startDate) && inv.date <= endDate) {
      raw.push({ date: inv.date, type: 'invoice', ref: inv.id, amount: inv.total });
    }
  }
  for (const pay of payments) {
    if ((startDate === null || pay.date >= startDate) && pay.date <= endDate) {
      raw.push({ date: pay.date, type: 'payment', ref: pay.ref, amount: -pay.amount });
    }
  }
  // Chronological; invoices before payments on the same day so a same-day
  // payment never drives the running balance below the charge it settles.
  raw.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.type !== b.type) return a.type === 'invoice' ? -1 : 1;
    return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
  });

  let balance = opening;
  const activity: StatementLine[] = raw.map((line) => {
    balance = roundCurrency(balance + line.amount);
    return { ...line, amount: roundCurrency(line.amount), balance };
  });

  return { openingBalance: opening, activity, closingBalance: balance };
}

/**
 * Aging of open invoice amounts AS OF endDate. An invoice's open amount is
 * its total minus payments allocated to it dated <= endDate; buckets follow
 * days past due relative to endDate.
 */
export function computeStatementAging(
  invoices: StatementInvoiceInput[],
  payments: StatementPaymentInput[],
  endDate: string,
): StatementAging {
  const paidByInvoice = new Map<string, number>();
  for (const pay of payments) {
    if (pay.date > endDate) continue;
    for (const alloc of pay.allocations) {
      paidByInvoice.set(
        alloc.invoiceGuid,
        (paidByInvoice.get(alloc.invoiceGuid) ?? 0) + alloc.amount,
      );
    }
  }

  const aging: StatementAging = { current: 0, b1_30: 0, b31_60: 0, b61_90: 0, b90plus: 0, total: 0 };
  for (const inv of invoices) {
    if (inv.date > endDate) continue;
    const open = roundCurrency(inv.total - (paidByInvoice.get(inv.guid) ?? 0));
    if (Math.abs(open) < 0.005) continue;
    const due = inv.dueDate ?? inv.date;
    const daysPast = daysBetweenIso(due, endDate);
    if (daysPast <= 0) aging.current += open;
    else if (daysPast <= 30) aging.b1_30 += open;
    else if (daysPast <= 60) aging.b31_60 += open;
    else if (daysPast <= 90) aging.b61_90 += open;
    else aging.b90plus += open;
    aging.total += open;
  }
  aging.current = roundCurrency(aging.current);
  aging.b1_30 = roundCurrency(aging.b1_30);
  aging.b31_60 = roundCurrency(aging.b31_60);
  aging.b61_90 = roundCurrency(aging.b61_90);
  aging.b90plus = roundCurrency(aging.b90plus);
  aging.total = roundCurrency(aging.total);
  return aging;
}

/* ------------------------------------------------------------------ */
/* DB loader                                                            */
/* ------------------------------------------------------------------ */

export class StatementNotFoundError extends Error {}

/**
 * Build a printable statement for a customer. Includes invoices owned
 * directly by the customer AND by the customer's jobs (same scoping as
 * payments). Only POSTED documents participate.
 */
export async function getCustomerStatement(
  customerGuid: string,
  startDate: string | null,
  endDate: string,
): Promise<CustomerStatement> {
  const customer = await prisma.customers.findUnique({ where: { guid: customerGuid } });
  if (!customer) throw new StatementNotFoundError(`Customer not found: ${customerGuid}`);

  const currency = await prisma.commodities.findUnique({
    where: { guid: customer.currency },
    select: { mnemonic: true },
  });

  // Direct + job-owned posted invoices for this customer
  const jobs = await prisma.jobs.findMany({
    where: { owner_type: OWNER_TYPE_CUSTOMER, owner_guid: customerGuid },
    select: { guid: true },
  });
  const jobGuids = jobs.map((j) => j.guid);
  const invoiceRows = await prisma.invoices.findMany({
    where: {
      post_txn: { not: null },
      OR: [
        { owner_type: OWNER_TYPE_CUSTOMER, owner_guid: customerGuid },
        ...(jobGuids.length > 0
          ? [{ owner_type: OWNER_TYPE_JOB, owner_guid: { in: jobGuids } }]
          : []),
      ],
    },
    select: { guid: true },
  });

  const statementInvoices: StatementInvoiceInput[] = [];
  for (const row of invoiceRows) {
    try {
      const view = await getInvoiceWithStatus(row.guid);
      if (!view.datePosted) continue;
      statementInvoices.push({
        guid: view.guid,
        id: view.id,
        date: view.datePosted,
        total: view.totals.total,
        dueDate: view.dueDate,
      });
    } catch {
      // Skip orphaned documents (missing owner rows etc.)
      continue;
    }
  }

  const paymentViews = await listPayments('customer', customerGuid);
  const statementPayments: StatementPaymentInput[] = paymentViews
    .filter((p) => p.date !== null)
    .map((p) => ({
      txGuid: p.transactionGuid,
      date: p.date as string,
      ref: p.num || 'Payment',
      amount: p.amount,
      allocations: p.allocations.map((a) => ({ invoiceGuid: a.invoiceGuid, amount: a.amount })),
    }));

  const { openingBalance, activity, closingBalance } = buildStatementActivity(
    statementInvoices,
    statementPayments,
    startDate,
    endDate,
  );
  const aging = computeStatementAging(statementInvoices, statementPayments, endDate);

  return {
    customer: {
      guid: customer.guid,
      id: customer.id,
      name: customer.name,
      currency: currency?.mnemonic ?? 'USD',
      address: {
        name: customer.addr_name ?? null,
        addr1: customer.addr_addr1 ?? null,
        addr2: customer.addr_addr2 ?? null,
        addr3: customer.addr_addr3 ?? null,
        addr4: customer.addr_addr4 ?? null,
      },
    },
    period: { startDate, endDate },
    openingBalance,
    activity,
    closingBalance,
    aging,
  };
}
