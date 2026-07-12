/**
 * Employees service — CRUD over the native GnuCash `employees` table (already
 * present in prisma/schema.prisma; no schema changes) plus the per-employee
 * voucher summary used by the Employee Report panel.
 *
 * GnuCash conventions preserved (mirrors business.service.ts, which is
 * imported READ-ONLY here):
 *   - guid: 32-char lowercase hex
 *   - `active` is an int flag (1/0)
 *   - `username` is the primary identifier; the display name lives in
 *     addr_name (that's how the desktop employee dialog stores "Name")
 *   - workday/rate are gnc_numeric fractions — stored with denom 100
 *   - `currency` stores a commodity GUID; the API surface speaks mnemonics
 *   - `id` is a zero-padded auto-number (max existing numeric id + 1),
 *     same scheme as customers/vendors (nextEntityId)
 *   - employees referenced by vouchers (invoices owner_type=5) are never
 *     hard-deleted — they are deactivated instead
 *   - like the other business entity tables, employees have no book_guid
 *     column and are UNSCOPED (single-business-database assumption); the
 *     voucher summary IS book-scoped via post_acc
 */

import { z } from 'zod';
import prisma from '@/lib/prisma';
import { generateGuid, fromDecimal, toDecimalNumber } from '@/lib/gnucash';
import {
  nextEntityId,
  BusinessValidationError,
  type DeleteResult,
} from '@/lib/services/business.service';
import type { AddressDTO } from '@/lib/business-types';
import { OWNER_TYPE_EMPLOYEE } from './invoice-engine';

const WORKDAY_RATE_DENOM = 100;

export interface EmployeeDTO {
  guid: string;
  id: string;
  username: string;
  /** Display name (addr_name). */
  name: string | null;
  language: string;
  active: boolean;
  /** Currency mnemonic, e.g. 'USD'. */
  currency: string;
  /** Hours per workday. */
  workday: number;
  /** Default hourly rate. */
  rate: number;
  address: AddressDTO;
  voucherCount: number;
}

/* ------------------------------------------------------------------ */
/* Validation                                                           */
/* ------------------------------------------------------------------ */

const addressSchema = z.object({
  name: z.string().max(1024).nullish(),
  addr1: z.string().max(1024).nullish(),
  addr2: z.string().max(1024).nullish(),
  addr3: z.string().max(1024).nullish(),
  addr4: z.string().max(1024).nullish(),
  phone: z.string().max(128).nullish(),
  fax: z.string().max(128).nullish(),
  email: z.string().max(256).nullish(),
});

export const employeeInputSchema = z.object({
  username: z.string().trim().min(1, 'username is required').max(2048),
  language: z.string().max(2048).default(''),
  active: z.boolean().default(true),
  currency: z.string().trim().min(3).max(10).default('USD'),
  workday: z.number().min(0).default(8),
  rate: z.number().min(0).default(0),
  address: addressSchema.default({}),
});
export type EmployeeInput = z.infer<typeof employeeInputSchema>;

/* ------------------------------------------------------------------ */
/* Mapping                                                              */
/* ------------------------------------------------------------------ */

type EmployeeRow = NonNullable<Awaited<ReturnType<typeof prisma.employees.findUnique>>>;

async function resolveCurrencyGuid(mnemonic: string): Promise<string> {
  const commodity = await prisma.commodities.findFirst({
    where: { namespace: 'CURRENCY', mnemonic: mnemonic.toUpperCase() },
    select: { guid: true },
  });
  if (!commodity) throw new BusinessValidationError(`Unknown currency: ${mnemonic}`);
  return commodity.guid;
}

interface EmployeeLookups {
  currencies: Map<string, string>;
  voucherCounts: Map<string, number>;
}

async function employeeLookups(rows: EmployeeRow[]): Promise<EmployeeLookups> {
  const currencyGuids = [...new Set(rows.map((r) => r.currency))];
  const [currencies, vouchers] = await Promise.all([
    currencyGuids.length > 0
      ? prisma.commodities.findMany({
          where: { guid: { in: currencyGuids } },
          select: { guid: true, mnemonic: true },
        })
      : Promise.resolve([]),
    rows.length > 0
      ? prisma.invoices.groupBy({
          by: ['owner_guid'],
          where: { owner_type: OWNER_TYPE_EMPLOYEE, owner_guid: { in: rows.map((r) => r.guid) } },
          _count: { guid: true },
        })
      : Promise.resolve([]),
  ]);
  return {
    currencies: new Map(currencies.map((c) => [c.guid, c.mnemonic])),
    voucherCounts: new Map(vouchers.map((v) => [v.owner_guid as string, v._count.guid])),
  };
}

function mapEmployee(row: EmployeeRow, lookups: EmployeeLookups): EmployeeDTO {
  return {
    guid: row.guid,
    id: row.id,
    username: row.username,
    name: row.addr_name ?? null,
    language: row.language,
    active: row.active === 1,
    currency: lookups.currencies.get(row.currency) ?? row.currency,
    workday: toDecimalNumber(row.workday_num, row.workday_denom),
    rate: toDecimalNumber(row.rate_num, row.rate_denom),
    address: {
      name: row.addr_name ?? null,
      addr1: row.addr_addr1 ?? null,
      addr2: row.addr_addr2 ?? null,
      addr3: row.addr_addr3 ?? null,
      addr4: row.addr_addr4 ?? null,
      phone: row.addr_phone ?? null,
      fax: row.addr_fax ?? null,
      email: row.addr_email ?? null,
    },
    voucherCount: lookups.voucherCounts.get(row.guid) ?? 0,
  };
}

function addressColumns(input: EmployeeInput) {
  return {
    addr_name: input.address.name?.trim() || null,
    addr_addr1: input.address.addr1?.trim() || null,
    addr_addr2: input.address.addr2?.trim() || null,
    addr_addr3: input.address.addr3?.trim() || null,
    addr_addr4: input.address.addr4?.trim() || null,
    addr_phone: input.address.phone?.trim() || null,
    addr_fax: input.address.fax?.trim() || null,
    addr_email: input.address.email?.trim() || null,
  };
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                 */
/* ------------------------------------------------------------------ */

export interface EmployeeListOptions {
  search?: string;
  active?: 'active' | 'inactive' | 'all';
}

export async function listEmployees(options: EmployeeListOptions = {}): Promise<EmployeeDTO[]> {
  const { search, active = 'all' } = options;
  const rows = await prisma.employees.findMany({
    where: {
      ...(active === 'active' ? { active: 1 } : active === 'inactive' ? { active: 0 } : {}),
      ...(search
        ? {
            OR: [
              { username: { contains: search, mode: 'insensitive' as const } },
              { id: { contains: search, mode: 'insensitive' as const } },
              { addr_name: { contains: search, mode: 'insensitive' as const } },
              { addr_email: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    },
    orderBy: [{ username: 'asc' }],
  });
  const lookups = await employeeLookups(rows);
  return rows.map((r) => mapEmployee(r, lookups));
}

export async function getEmployee(guid: string): Promise<EmployeeDTO | null> {
  const row = await prisma.employees.findUnique({ where: { guid } });
  if (!row) return null;
  const lookups = await employeeLookups([row]);
  return mapEmployee(row, lookups);
}

export async function createEmployee(input: EmployeeInput): Promise<EmployeeDTO> {
  const currencyGuid = await resolveCurrencyGuid(input.currency);
  const existing = await prisma.employees.findMany({ select: { id: true } });
  const workday = fromDecimal(input.workday, WORKDAY_RATE_DENOM);
  const rate = fromDecimal(input.rate, WORKDAY_RATE_DENOM);
  const guid = generateGuid();

  await prisma.employees.create({
    data: {
      guid,
      id: nextEntityId(existing.map((r) => r.id)),
      username: input.username,
      language: input.language,
      acl: '',
      active: input.active ? 1 : 0,
      currency: currencyGuid,
      ccard_guid: null,
      workday_num: workday.num,
      workday_denom: workday.denom,
      rate_num: rate.num,
      rate_denom: rate.denom,
      ...addressColumns(input),
    },
  });

  return (await getEmployee(guid))!;
}

export async function updateEmployee(guid: string, input: EmployeeInput): Promise<EmployeeDTO | null> {
  const existing = await prisma.employees.findUnique({ where: { guid } });
  if (!existing) return null;

  const currencyGuid = await resolveCurrencyGuid(input.currency);
  const workday = fromDecimal(input.workday, WORKDAY_RATE_DENOM);
  const rate = fromDecimal(input.rate, WORKDAY_RATE_DENOM);

  await prisma.employees.update({
    where: { guid },
    data: {
      username: input.username,
      language: input.language,
      active: input.active ? 1 : 0,
      currency: currencyGuid,
      workday_num: workday.num,
      workday_denom: workday.denom,
      rate_num: rate.num,
      rate_denom: rate.denom,
      ...addressColumns(input),
    },
  });

  return getEmployee(guid);
}

export async function deleteEmployee(guid: string): Promise<DeleteResult | null> {
  const existing = await prisma.employees.findUnique({ where: { guid } });
  if (!existing) return null;

  const vouchers = await prisma.invoices.count({
    where: { owner_type: OWNER_TYPE_EMPLOYEE, owner_guid: guid },
  });
  if (vouchers > 0) {
    await prisma.employees.update({ where: { guid }, data: { active: 0 } });
    return { deleted: false, deactivated: true };
  }

  await prisma.employees.delete({ where: { guid } });
  return { deleted: true, deactivated: false };
}

/* ------------------------------------------------------------------ */
/* Employee Report — pure builder                                       */
/* ------------------------------------------------------------------ */

/** Raw per-voucher row from the loader (DB-free for tests). */
export interface RawEmployeeVoucherRow {
  guid: string;
  posted: boolean;
  /** 'YYYY-MM' of the post date; null for drafts. */
  month: string | null;
  /** Raw A/P post-split sum (bill sign: -total); null for drafts. */
  postTotal: number | null;
  /** Raw lot-split sum (negative = unreimbursed); null for drafts. */
  lotBalance: number | null;
}

export interface EmployeeVoucherMonthRow {
  month: string;
  total: number;
  outstanding: number;
}

export interface EmployeeVoucherSummary {
  voucherCount: number;
  draftCount: number;
  /** Sum of posted voucher totals. */
  totalPosted: number;
  /** Unreimbursed amount across posted vouchers. */
  outstanding: number;
  /** totalPosted - outstanding. */
  paid: number;
  /** Posted totals per month, most recent first. */
  byMonth: EmployeeVoucherMonthRow[];
}

function round2(n: number): number {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r; // normalize -0
}

/**
 * Roll up an employee's vouchers. Pure. Vouchers post on the A/P side, so
 * raw post/lot sums are NEGATIVE while unpaid — normalized here to read
 * positive (same convention as amountDueFromLotBalance('ap')).
 */
export function buildEmployeeVoucherSummary(
  rows: ReadonlyArray<RawEmployeeVoucherRow>,
): EmployeeVoucherSummary {
  let totalPosted = 0;
  let outstanding = 0;
  let voucherCount = 0;
  let draftCount = 0;
  const byMonth = new Map<string, EmployeeVoucherMonthRow>();

  for (const row of rows) {
    if (!row.posted) {
      draftCount++;
      continue;
    }
    voucherCount++;
    const total = round2(-(row.postTotal ?? 0));
    const due = round2(-(row.lotBalance ?? 0));
    totalPosted = round2(totalPosted + total);
    outstanding = round2(outstanding + due);
    if (row.month) {
      let m = byMonth.get(row.month);
      if (!m) {
        m = { month: row.month, total: 0, outstanding: 0 };
        byMonth.set(row.month, m);
      }
      m.total = round2(m.total + total);
      m.outstanding = round2(m.outstanding + due);
    }
  }

  return {
    voucherCount,
    draftCount,
    totalPosted,
    outstanding,
    paid: round2(totalPosted - outstanding),
    byMonth: [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month)),
  };
}

/* ------------------------------------------------------------------ */
/* Employee Report — SQL loader                                         */
/* ------------------------------------------------------------------ */

/** Posted vouchers are book-scoped via post_acc; drafts counted unscoped. */
export async function loadEmployeeVouchers(
  employeeGuid: string,
  bookAccountGuids: string[],
): Promise<RawEmployeeVoucherRow[]> {
  const rows = await prisma.$queryRaw<
    { guid: string; posted: boolean; month: string | null; post_total: number | null; lot_balance: number | null }[]
  >`
    SELECT
      i.guid,
      (i.post_txn IS NOT NULL) AS posted,
      to_char(i.date_posted, 'YYYY-MM') AS month,
      (
        SELECT SUM(ps.value_num::numeric / NULLIF(ps.value_denom, 0)::numeric)
        FROM splits ps
        WHERE ps.tx_guid = i.post_txn AND ps.account_guid = i.post_acc
      )::float8 AS post_total,
      (
        SELECT SUM(ls.value_num::numeric / NULLIF(ls.value_denom, 0)::numeric)
        FROM splits ls
        WHERE ls.lot_guid = i.post_lot
      )::float8 AS lot_balance
    FROM invoices i
    WHERE i.owner_type = ${OWNER_TYPE_EMPLOYEE}
      AND i.owner_guid = ${employeeGuid}
      AND (i.post_txn IS NULL OR i.post_acc = ANY(${bookAccountGuids}::text[]))
  `;

  return rows.map((r) => ({
    guid: r.guid,
    posted: r.posted,
    month: r.month,
    postTotal: r.post_total,
    lotBalance: r.lot_balance,
  }));
}

/** Full per-employee voucher summary for the active book. */
export async function generateEmployeeVoucherSummary(
  employeeGuid: string,
  bookAccountGuids: string[],
): Promise<EmployeeVoucherSummary> {
  const rows = await loadEmployeeVouchers(employeeGuid, bookAccountGuids);
  return buildEmployeeVoucherSummary(rows);
}
