/**
 * OFX account auto-detect — PURE helpers (no I/O, no DB).
 *
 * An OFX/QFX file identifies its source account via <ACCTID> (see
 * parseStatementOfx). We remember which ledger account each ofx_acct_id was
 * reconciled against per book (gnucash_web_statement_acct_map) so later
 * uploads of the same account can skip the account picker entirely.
 *
 * This module contains only the deterministic decision logic; the DB reads /
 * writes live in src/lib/services/statement.service.ts and are driven from
 * src/lib/statement-ingest.ts.
 */

/** Max length of the stored identifier (ofx_acct_id VARCHAR(64)). */
export const OFX_ACCT_ID_MAX_LENGTH = 64;

/**
 * Normalize a raw <ACCTID> value for storage/lookup:
 *   - trims surrounding whitespace
 *   - collapses internal whitespace runs to a single space
 *   - truncates to OFX_ACCT_ID_MAX_LENGTH
 *   - returns null for missing/empty values
 *
 * Deliberately does NOT change case or strip separators — banks emit stable
 * literal ids and we must not merge distinct accounts.
 */
export function normalizeOfxAcctId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.slice(0, OFX_ACCT_ID_MAX_LENGTH);
}

export interface OfxAccountPlanInput {
  /** Raw <ACCTID> from the parsed statement (may be missing). */
  rawAcctId: string | null | undefined;
  /** account_guid already on the batch (user picked one at upload), if any. */
  batchAccountGuid: string | null;
  /** account_guid remembered for (book, acctId) in the map table, if any. */
  mappedAccountGuid: string | null;
}

export interface OfxAccountPlan {
  /** Normalized id to persist on the batch (ofx_acct_id), or null. */
  ofxAcctId: string | null;
  /**
   * Account to remember in the map table (upsert (book, ofxAcctId) → guid),
   * or null when there is nothing to remember.
   */
  rememberAccountGuid: string | null;
  /**
   * Account to auto-assign to the batch (batch had none but the id maps),
   * or null when no assignment should happen.
   */
  assignAccountGuid: string | null;
}

/**
 * Decide what to do with an OFX account id during ingest:
 *   - no acctId            → store nothing, do nothing
 *   - batch has an account → remember the pairing (upsert the map)
 *   - batch lacks account  → auto-assign from the map when a pairing exists
 */
export function planOfxAccountActions(input: OfxAccountPlanInput): OfxAccountPlan {
  const ofxAcctId = normalizeOfxAcctId(input.rawAcctId);
  if (!ofxAcctId) {
    return { ofxAcctId: null, rememberAccountGuid: null, assignAccountGuid: null };
  }
  if (input.batchAccountGuid) {
    return { ofxAcctId, rememberAccountGuid: input.batchAccountGuid, assignAccountGuid: null };
  }
  if (input.mappedAccountGuid) {
    return { ofxAcctId, rememberAccountGuid: null, assignAccountGuid: input.mappedAccountGuid };
  }
  return { ofxAcctId, rememberAccountGuid: null, assignAccountGuid: null };
}
