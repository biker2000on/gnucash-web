/**
 * TXF mapping layer.
 *
 * Two sources decide which TXF reference code an account's activity lands on:
 *
 *   1. Category defaults — the app's existing tax categories (stored in
 *      gnucash_web_tax_mappings and expanded to descendants by the tax
 *      estimator) map to a default TXF code via CATEGORY_TXF_CODES below.
 *      Categories with no sensible TXF line (FICA, 401(k) payroll deferrals
 *      that already live in W-2 box 12, 529/ESA, employer match, exclude)
 *      map to null and are omitted from the report/export.
 *
 *   2. Per-account overrides — stored in gnucash_web_txf_overrides, created
 *      lazily via raw SQL under an advisory lock (same pattern as
 *      src/lib/business/schedule-c-mappings.ts; the GnuCash DB rejects
 *      `prisma db push`, so the table is NOT in the Prisma schema and must
 *      NOT be added to db-init.ts). An override always wins over the
 *      category default and is the only way to give a TXF code to a
 *      tax_related-flagged account that has no tax-category mapping.
 */

import prisma from '@/lib/prisma';
import type { TaxCategory } from './types';
import { isValidTxfCode } from './txf-codes';

/* ------------------------------------------------------------------ */
/* Category → default TXF code                                          */
/* ------------------------------------------------------------------ */

/**
 * Default TXF code per tax category. null = no TXF line:
 *   - fica_*: employer-reported payroll taxes, never entered in tax software.
 *   - trad/roth 401(k) + employer match: reported via W-2 box 12, not TXF.
 *   - roth_ira: not deductible; basis tracking is out of scope for TXF.
 *   - 529/ESA: no federal treatment (state-level only).
 *   - education_expense: credits (Form 8863) need per-student data TXF
 *     summary records can't carry.
 *   - exclude: explicitly suppressed.
 */
export const CATEGORY_TXF_CODES: Record<TaxCategory, string | null> = {
  w2_wages: 'N256',
  federal_withholding: 'N522',
  state_withholding: 'N521',
  estimated_tax_payment: 'N523',
  state_estimated_tax_payment: 'N524',
  fica_social_security: null,
  fica_medicare: null,
  interest_income: 'N287',
  tax_exempt_interest: 'N489',
  ordinary_dividends: 'N488',
  qualified_dividends: 'N286',
  self_employment_income: 'N261',
  business_expense: 'N307',
  rental_income: 'N372',
  retirement_income: 'N473',
  social_security_benefits: 'N483',
  hsa_contribution: 'N625',
  trad_401k_contribution: null,
  roth_401k_contribution: null,
  trad_ira_contribution: 'N304',
  roth_ira_contribution: null,
  sep_ira_contribution: 'N432',
  simple_ira_contribution: 'N433',
  employer_match: null,
  education_529_contribution: null,
  esa_contribution: null,
  charitable_donation: 'N565',
  mortgage_interest: 'N564',
  property_tax: 'N540',
  state_local_tax_paid: 'N521',
  medical_expense: 'N545',
  education_expense: null,
  other_income: 'N262',
  other_deduction: 'N568',
  exclude: null,
};

/**
 * PURE. Resolve the effective TXF code for an account: per-account override
 * first, then the category default. Returns null when neither applies.
 */
export function resolveTxfCode(
  category: TaxCategory | null | undefined,
  overrideCode: string | null | undefined,
): string | null {
  if (overrideCode && isValidTxfCode(overrideCode)) return overrideCode;
  if (category && category !== 'exclude') return CATEGORY_TXF_CODES[category] ?? null;
  return null;
}

/* ------------------------------------------------------------------ */
/* Override change validation (pure)                                    */
/* ------------------------------------------------------------------ */

export interface TxfOverrideChange {
  accountGuid: string;
  /** Target TXF code, or null to remove the override. */
  code: string | null;
}

export interface PartitionedTxfChanges {
  upserts: Array<{ accountGuid: string; code: string }>;
  deletes: string[];
}

export class TxfOverrideValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TxfOverrideValidationError';
  }
}

/**
 * PURE. Validate and split a batch of override changes into upserts + deletes.
 * Each GUID must be a 32-char guid inside `bookAccountGuids`; a non-null code
 * must exist in the TXF code table. Throws TxfOverrideValidationError on the
 * first invalid entry.
 */
export function partitionTxfOverrideChanges(
  changes: ReadonlyArray<TxfOverrideChange>,
  bookAccountGuids: ReadonlySet<string>,
): PartitionedTxfChanges {
  const upserts: Array<{ accountGuid: string; code: string }> = [];
  const deletes: string[] = [];

  for (const change of changes) {
    const guid = change?.accountGuid;
    if (typeof guid !== 'string' || guid.length !== 32 || !bookAccountGuids.has(guid)) {
      throw new TxfOverrideValidationError(
        `Invalid or out-of-book account guid: ${String(guid)}`,
      );
    }
    if (change.code === null) {
      deletes.push(guid);
    } else if (isValidTxfCode(change.code)) {
      upserts.push({ accountGuid: guid, code: change.code });
    } else {
      throw new TxfOverrideValidationError(`Invalid TXF code: ${String(change.code)}`);
    }
  }

  return { upserts, deletes };
}

/* ------------------------------------------------------------------ */
/* Lazy table creation                                                  */
/* ------------------------------------------------------------------ */

let ensurePromise: Promise<void> | null = null;

export function ensureTxfOverridesTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        DO $$
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_txf_overrides_schema'));

            CREATE TABLE IF NOT EXISTS gnucash_web_txf_overrides (
                account_guid VARCHAR(32) PRIMARY KEY,
                txf_code VARCHAR(8) NOT NULL,
                created_at TIMESTAMP DEFAULT now(),
                updated_at TIMESTAMP DEFAULT now()
            );
        END $$;
      `);
    })();
  }
  return ensurePromise;
}

/* ------------------------------------------------------------------ */
/* Read / write                                                         */
/* ------------------------------------------------------------------ */

/**
 * Per-account TXF overrides for the given book accounts, keyed by account
 * GUID → code. Codes no longer in the table (removed/renumbered) are skipped
 * so the report falls back to the category default for them.
 */
export async function getTxfOverrides(
  bookAccountGuids: string[],
): Promise<Record<string, string>> {
  await ensureTxfOverridesTable();
  if (bookAccountGuids.length === 0) return {};

  const rows = await prisma.$queryRaw<
    Array<{ account_guid: string; txf_code: string }>
  >`
    SELECT account_guid, txf_code
    FROM gnucash_web_txf_overrides
    WHERE account_guid = ANY(${bookAccountGuids}::text[])
  `;

  const map: Record<string, string> = {};
  for (const row of rows) {
    if (isValidTxfCode(row.txf_code)) {
      map[row.account_guid] = row.txf_code;
    }
  }
  return map;
}

/**
 * Apply a batch of override changes. Validates via partitionTxfOverrideChanges
 * (throws TxfOverrideValidationError on bad input) before touching the DB.
 * null codes delete the override; valid codes upsert it.
 */
export async function saveTxfOverrides(
  changes: ReadonlyArray<TxfOverrideChange>,
  bookAccountGuids: string[],
): Promise<void> {
  const { upserts, deletes } = partitionTxfOverrideChanges(
    changes,
    new Set(bookAccountGuids),
  );

  await ensureTxfOverridesTable();

  if (deletes.length > 0) {
    await prisma.$executeRaw`
      DELETE FROM gnucash_web_txf_overrides
      WHERE account_guid = ANY(${deletes}::text[])
    `;
  }

  for (const upsert of upserts) {
    await prisma.$executeRaw`
      INSERT INTO gnucash_web_txf_overrides (account_guid, txf_code)
      VALUES (${upsert.accountGuid}, ${upsert.code})
      ON CONFLICT (account_guid) DO UPDATE
          SET txf_code = EXCLUDED.txf_code,
              updated_at = now()
    `;
  }
}
