/**
 * Tax Schedule Report — GnuCash desktop parity.
 *
 * For a tax year, aggregates the splits of every tax-relevant account into
 * TXF-coded line items grouped by IRS form, feeding both the report page and
 * the .txf export.
 *
 * An account is tax-relevant when any of:
 *   - it has an effective tax-category mapping (direct row in
 *     gnucash_web_tax_mappings or inherited from a mapped ancestor) that
 *     resolves to a TXF code,
 *   - it has a per-account TXF override (gnucash_web_txf_overrides),
 *   - it is flagged tax_related in gnucash_web_account_preferences — these
 *     surface in `unmappedTaxRelated` when no code resolves, so the user can
 *     assign one from the report page.
 *
 * Sign convention: GnuCash stores income as credits (negative values); the
 * report presents income positive. Expense/withholding/deduction accounts
 * are debit-normal and pass through as stored. Concretely: INCOME-type
 * accounts are negated, everything else is not.
 */

import prisma from '@/lib/prisma';
import { expandMappingsToDescendants } from './book-income';
import { isTaxCategory, type TaxCategory } from './types';
import { getTxfCode, TXF_FORM_ORDER, type TxfCode } from './txf-codes';
import { getTxfOverrides, resolveTxfCode } from './txf';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export interface TaxScheduleAccountRow {
  accountGuid: string;
  path: string;
  accountType: string;
  /** Presented amount (income already sign-flipped positive). */
  amount: number;
  /** How the account got its code. */
  source: 'override' | 'category';
  category: TaxCategory | null;
}

export interface TaxScheduleLineItem {
  code: string;
  form: string;
  line: string;
  description: string;
  sign: 'income' | 'deduction';
  payerSupported: boolean;
  accounts: TaxScheduleAccountRow[];
  total: number;
}

export interface UnmappedTaxRelatedAccount {
  accountGuid: string;
  path: string;
  accountType: string;
  /** Year activity (presented sign) so the user can judge materiality. */
  amount: number;
}

export interface TaxScheduleReport {
  year: number;
  generatedAt: string;
  /** Line items sorted by form (1040, A, B, C, D, E) then code. */
  items: TaxScheduleLineItem[];
  /** tax_related-flagged accounts with no resolvable TXF code. */
  unmappedTaxRelated: UnmappedTaxRelatedAccount[];
  /** Current per-account overrides (guid → TXF code) for the mapping panel. */
  overrides: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* Pure aggregation core                                                */
/* ------------------------------------------------------------------ */

export interface TaxScheduleAccountInput {
  guid: string;
  path: string;
  accountType: string;
  /** Raw GnuCash-sign year total (income negative). */
  rawTotal: number;
  /** Effective tax category (after descendant expansion), if any. */
  category: TaxCategory | null;
  /** Per-account TXF override, if any. */
  overrideCode: string | null;
  taxRelated: boolean;
}

/** Round to cents. */
function cents(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Present GnuCash raw sign for the user: income accounts flip positive. */
export function presentAmount(accountType: string, rawTotal: number): number {
  return cents(accountType === 'INCOME' ? -rawTotal : rawTotal);
}

/**
 * PURE. Bucket accounts into TXF line items + collect unmapped tax_related
 * accounts. Zero-activity accounts are dropped from line items; unmapped
 * tax_related accounts are always listed (their gap is the warning).
 */
export function buildTaxScheduleItems(
  accounts: readonly TaxScheduleAccountInput[],
): { items: TaxScheduleLineItem[]; unmappedTaxRelated: UnmappedTaxRelatedAccount[] } {
  const byCode = new Map<string, TaxScheduleLineItem>();
  const unmapped: UnmappedTaxRelatedAccount[] = [];

  for (const account of accounts) {
    const code = resolveTxfCode(account.category, account.overrideCode);
    const amount = presentAmount(account.accountType, account.rawTotal);

    if (!code) {
      if (account.taxRelated) {
        unmapped.push({
          accountGuid: account.guid,
          path: account.path,
          accountType: account.accountType,
          amount,
        });
      }
      continue;
    }

    if (Math.abs(amount) < 0.005) continue;

    const def: TxfCode | undefined = getTxfCode(code);
    if (!def) continue; // defensive: resolveTxfCode only returns table codes

    let item = byCode.get(code);
    if (!item) {
      item = {
        code: def.code,
        form: def.form,
        line: def.line,
        description: def.description,
        sign: def.sign,
        payerSupported: def.payerSupported,
        accounts: [],
        total: 0,
      };
      byCode.set(code, item);
    }
    item.accounts.push({
      accountGuid: account.guid,
      path: account.path,
      accountType: account.accountType,
      amount,
      source: account.overrideCode ? 'override' : 'category',
      category: account.category,
    });
  }

  const formRank = (form: string) => {
    const idx = TXF_FORM_ORDER.indexOf(form);
    return idx === -1 ? TXF_FORM_ORDER.length : idx;
  };

  const items = [...byCode.values()]
    .map(item => {
      item.accounts.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
      // Sum in integer cents to avoid float drift.
      item.total =
        item.accounts.reduce((sum, a) => sum + Math.round(a.amount * 100), 0) / 100;
      return item;
    })
    .sort(
      (a, b) =>
        formRank(a.form) - formRank(b.form) ||
        a.form.localeCompare(b.form) ||
        a.code.localeCompare(b.code),
    );

  unmapped.sort((a, b) => a.path.localeCompare(b.path));

  return { items, unmappedTaxRelated: unmapped };
}

/* ------------------------------------------------------------------ */
/* DB-backed generator                                                  */
/* ------------------------------------------------------------------ */

interface AccountInfo {
  guid: string;
  name: string;
  fullname: string;
  account_type: string;
  parent_guid: string | null;
}

export async function generateTaxSchedule(
  bookAccountGuids: string[],
  year: number,
): Promise<TaxScheduleReport> {
  const startDate = new Date(Date.UTC(year, 0, 1));
  const endDate = new Date(Date.UTC(year, 11, 31, 23, 59, 59));

  if (bookAccountGuids.length === 0) {
    return {
      year,
      generatedAt: new Date().toISOString(),
      items: [],
      unmappedTaxRelated: [],
      overrides: {},
    };
  }

  const [mappingRows, accountRows, taxRelatedPrefs, overrides] = await Promise.all([
    prisma.gnucash_web_tax_mappings.findMany({
      where: { account_guid: { in: bookAccountGuids } },
    }),
    prisma.$queryRaw<AccountInfo[]>`
      SELECT guid, name, fullname, account_type, parent_guid
      FROM account_hierarchy
      WHERE guid = ANY(${bookAccountGuids})
    `,
    prisma.gnucash_web_account_preferences.findMany({
      where: { account_guid: { in: bookAccountGuids }, tax_related: true },
      select: { account_guid: true },
    }),
    getTxfOverrides(bookAccountGuids),
  ]);

  const directMappings = new Map<string, TaxCategory>();
  for (const row of mappingRows) {
    if (isTaxCategory(row.tax_category)) {
      directMappings.set(row.account_guid, row.tax_category);
    }
  }
  const mappings = expandMappingsToDescendants(directMappings, accountRows);
  const taxRelatedGuids = new Set(taxRelatedPrefs.map(p => p.account_guid));

  /* Accounts that can appear in the report at all. */
  const relevant = accountRows.filter(a => {
    if (a.account_type === 'ROOT') return false;
    return (
      overrides[a.guid] !== undefined ||
      (mappings.has(a.guid) && mappings.get(a.guid) !== 'exclude') ||
      taxRelatedGuids.has(a.guid)
    );
  });

  /* Sum split values per relevant account inside the tax year. */
  const totals = new Map<string, number>();
  const relevantGuids = relevant.map(a => a.guid);
  if (relevantGuids.length > 0) {
    const rows = await prisma.$queryRaw<Array<{ account_guid: string; total: number | null }>>`
      SELECT s.account_guid,
             (SUM(s.value_num::numeric / s.value_denom))::float8 AS total
      FROM splits s
      JOIN transactions t ON s.tx_guid = t.guid
      WHERE s.account_guid = ANY(${relevantGuids})
        AND t.post_date >= ${startDate}
        AND t.post_date <= ${endDate}
        -- Exclude lot-scrub capital-gains offsets: zero-quantity, non-zero
        -- value splits carry no real money flow (see book-income.ts).
        AND NOT (s.quantity_num = 0 AND s.value_num <> 0)
      GROUP BY s.account_guid
    `;
    for (const row of rows) {
      if (row.total !== null) totals.set(row.account_guid, row.total);
    }
  }

  const inputs: TaxScheduleAccountInput[] = relevant.map(a => ({
    guid: a.guid,
    path: a.fullname || a.name,
    accountType: a.account_type,
    rawTotal: totals.get(a.guid) ?? 0,
    category: mappings.get(a.guid) ?? null,
    overrideCode: overrides[a.guid] ?? null,
    taxRelated: taxRelatedGuids.has(a.guid),
  }));

  const { items, unmappedTaxRelated } = buildTaxScheduleItems(inputs);

  return {
    year,
    generatedAt: new Date().toISOString(),
    items,
    unmappedTaxRelated,
    overrides,
  };
}
