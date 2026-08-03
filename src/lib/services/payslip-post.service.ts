/**
 * Payslip Transaction Posting Service
 *
 * Generates GnuCash transactions from payslip line items:
 * - Balance validation
 * - Split construction from line item mappings
 * - Atomic transaction creation via Prisma
 */

import { generateGuid, fromDecimal } from '@/lib/gnucash';
import prisma from '@/lib/prisma';
import type { PayslipLineItem } from '@/lib/types';
import { validatePayslipBalance, buildSplitsFromLineItems } from '@/lib/payslip-splits';
import { upsertTemplate, type PrismaTx } from '@/lib/payslips';
import { assertNotLocked, assertTxnMutable } from '@/lib/services/period-lock.service';
export type { PayslipSplit } from '@/lib/payslip-splits';
export { validatePayslipBalance, buildSplitsFromLineItems } from '@/lib/payslip-splits';

/**
 * How long a `posting` claim is honored before another attempt may take it
 * over. A process that dies mid-post leaves the row in `posting`; without this
 * TTL the payslip would be permanently unpostable.
 */
export const POSTING_CLAIM_TTL_MS = 5 * 60 * 1000;

/** Raised when another request already holds (or completed) this posting. */
export class PayslipPostConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayslipPostConflictError';
  }
}

/**
 * Atomically claim a payslip for posting.
 *
 * A single conditional UPDATE is the only thing that can stop a double-click
 * (or a browser retry of the slow AI-extraction POST) from writing the payslip
 * transaction twice: `findMatchingTransaction` and the route's status read are
 * plain SELECTs, so two requests can both pass them before either writes.
 *
 * The row is locked FOR UPDATE inside the CTE, so a concurrent claim blocks,
 * re-evaluates the predicate against the committed row, and finds `posting`.
 *
 * @returns the status the row held before the claim (for rollback).
 * @throws {PayslipPostConflictError} when the claim could not be taken.
 */
async function claimPayslipForPosting(payslipId: number): Promise<string> {
  const staleBefore = new Date(Date.now() - POSTING_CLAIM_TTL_MS);
  const claimed = await prisma.$queryRaw<Array<{ prior_status: string }>>`
    WITH candidate AS (
      SELECT id, status AS prior_status
      FROM gnucash_web_payslips
      WHERE id = ${payslipId}
        AND status <> 'posted'
        AND (status <> 'posting' OR updated_at IS NULL OR updated_at < ${staleBefore})
      FOR UPDATE
    )
    UPDATE gnucash_web_payslips p
    SET status = 'posting', updated_at = ${new Date()}
    FROM candidate c
    WHERE p.id = c.id
    RETURNING c.prior_status
  `;

  if (claimed.length === 0) {
    throw new PayslipPostConflictError(
      `Payslip ${payslipId} is already posted or a posting is already in progress`,
    );
  }
  return claimed[0].prior_status;
}

/**
 * Put the claim back so a genuine retry can proceed after a failed post.
 * Scoped to `status = 'posting'` so it can never clobber a status written by
 * the (successful) posting transaction itself. Best effort: the caller is
 * already unwinding with the real error.
 */
async function releasePayslipClaim(payslipId: number, priorStatus: string): Promise<void> {
  try {
    await prisma.$executeRaw`
      UPDATE gnucash_web_payslips
      SET status = ${priorStatus}, updated_at = ${new Date()}
      WHERE id = ${payslipId} AND status = 'posting'
    `;
  } catch (releaseError) {
    console.error(
      `Failed to release posting claim for payslip ${payslipId} (it will free itself after ${POSTING_CLAIM_TTL_MS}ms):`,
      releaseError,
    );
  }
}

async function linkPostedPayslip(
  bookGuid: string,
  payslipId: number,
  transactionGuid: string,
): Promise<void> {
  try {
    const { getDocumentBySource, linkDocument } = await import('@/lib/documents');
    const document = await getDocumentBySource(bookGuid, 'payslip', String(payslipId));
    if (document) {
      await linkDocument({
        bookGuid,
        documentId: document.id,
        targetType: 'transaction',
        targetId: transactionGuid,
        role: 'payslip',
        metadata: { autoSource: 'gnucash_web_payslips.transaction_guid' },
      });
    }
  } catch (canonicalError) {
    const detail = canonicalError instanceof Error
      ? canonicalError.message.slice(0, 500)
      : String(canonicalError).slice(0, 500);
    console.warn(`Canonical payslip link deferred for payslip ${payslipId}: ${detail}`);
  }
}

/**
 * Find an existing transaction that matches the payslip splits.
 *
 * Searches for transactions within +/- 3 days of the pay date where
 * every expected split has a matching split (same account, amount within $0.01).
 * Returns the transaction GUID if found, null otherwise.
 */
export async function findMatchingTransaction(
  splits: Array<{ accountGuid: string; amount: number }>,
  payDate: string,
  db: PrismaTx = prisma
): Promise<string | null> {
  const postDate = new Date(payDate + 'T12:00:00Z');
  const dateStart = new Date(postDate.getTime() - 3 * 24 * 60 * 60 * 1000);
  const dateEnd = new Date(postDate.getTime() + 3 * 24 * 60 * 60 * 1000);

  // Find candidate transactions in the date range that have the right number of splits
  const candidates = await db.$queryRaw<
    Array<{ guid: string; split_count: number }>
  >`
    SELECT t.guid, COUNT(s.guid)::int AS split_count
    FROM transactions t
    JOIN splits s ON s.tx_guid = t.guid
    WHERE t.post_date BETWEEN ${dateStart} AND ${dateEnd}
    GROUP BY t.guid
    HAVING COUNT(s.guid) = ${splits.length}
  `;

  for (const candidate of candidates) {
    // Get all splits for this candidate transaction
    const txSplits = await db.$queryRaw<
      Array<{ account_guid: string; amount: number }>
    >`
      SELECT account_guid, (value_num::float / value_denom::float) AS amount
      FROM splits
      WHERE tx_guid = ${candidate.guid}
    `;

    // Exact match: every split matches on both account GUID and amount
    const exactMatch = splits.every(expected => {
      return txSplits.some(actual =>
        actual.account_guid === expected.accountGuid &&
        Math.abs(actual.amount - expected.amount) < 0.015
      );
    });

    if (exactMatch) {
      return candidate.guid;
    }

    // Amount-only match: every expected split amount pairs 1:1 with an actual
    // split amount, even if account GUIDs differ (handles account remapping).
    // Use greedy 1:1 matching to avoid double-counting.
    const remainingActual = [...txSplits];
    const amountMatch = splits.every(expected => {
      const idx = remainingActual.findIndex(actual =>
        Math.abs(actual.amount - expected.amount) < 0.015
      );
      if (idx === -1) return false;
      remainingActual.splice(idx, 1);
      return true;
    });

    if (amountMatch) {
      return candidate.guid;
    }
  }

  return null;
}

/**
 * Find a SimpleFin-imported lump-sum deposit that matches this payslip.
 * Looks for transactions within +/- 3 days where:
 * - A split on the deposit account matches net pay within $0.02
 * - The transaction has SimpleFin metadata
 */
export async function findSimpleFinDeposit(
  depositAccountGuid: string,
  netPay: number,
  payDate: string
): Promise<string | null> {
  const postDate = new Date(payDate + 'T12:00:00Z');
  const dateStart = new Date(postDate.getTime() - 3 * 24 * 60 * 60 * 1000);
  const dateEnd = new Date(postDate.getTime() + 3 * 24 * 60 * 60 * 1000);

  const matches = await prisma.$queryRaw<Array<{ guid: string }>>`
    SELECT t.guid
    FROM transactions t
    JOIN splits s ON s.tx_guid = t.guid
    JOIN gnucash_web_transaction_meta m ON m.transaction_guid = t.guid
    WHERE s.account_guid = ${depositAccountGuid}
      AND ABS((s.value_num::float / s.value_denom::float) - ${netPay}) < 0.02
      AND t.post_date BETWEEN ${dateStart} AND ${dateEnd}
      AND m.source = 'simplefin'
    ORDER BY ABS(EXTRACT(EPOCH FROM (t.post_date - ${postDate}::timestamptz)))
    LIMIT 1
  `;

  return matches.length > 0 ? matches[0].guid : null;
}

/**
 * Post a payslip as a GnuCash transaction atomically.
 * If a SimpleFin deposit matches, replaces its splits with the detailed payslip breakdown.
 * If an existing transaction with full matching splits is found, links to it (dedup).
 * Otherwise creates a new transaction.
 *
 * @returns Transaction GUID (existing or newly created)
 */
export async function postPayslipTransaction(
  payslipId: number,
  bookGuid: string,
  currencyGuid: string,
  lineItems: PayslipLineItem[],
  mappings: Record<string, string>,
  depositAccountGuid: string,
  netPay: number,
  payDate: string,
  employerName: string,
  imbalanceAccountGuid?: string
): Promise<string> {
  const imbalance = validatePayslipBalance(lineItems, netPay);
  const splits = buildSplitsFromLineItems(lineItems, mappings, depositAccountGuid, netPay);

  // Add imbalance split if needed and account provided
  if (imbalance !== 0 && imbalanceAccountGuid) {
    splits.push({
      accountGuid: imbalanceAccountGuid,
      amount: imbalance,
      memo: 'Imbalance',
    });
  }

  // Verify splits sum to zero (GnuCash double-entry requirement)
  const splitsSum = Math.round(splits.reduce((sum, s) => sum + s.amount, 0) * 100) / 100;
  if (splitsSum !== 0) {
    throw new Error(`Transaction splits do not sum to zero: ${splitsSum}`);
  }

  // Period lock: posting writes a transaction dated payDate
  await assertNotLocked(bookGuid, [payDate]);

  // Claim the payslip BEFORE any ledger write. Everything below (the dedup
  // scan, the route's `status === 'posted'` read) is a plain SELECT, so
  // without this conditional UPDATE two concurrent posts both pass every check
  // and each writes a full payslip transaction — doubling income, withholding
  // and retirement contributions with nothing to detect it afterwards.
  const priorStatus = await claimPayslipForPosting(payslipId);

  const templateItems = lineItems.map(item => ({
    category: item.category,
    label: item.label,
    normalized_label: item.normalized_label,
  }));

  let transactionGuid: string;
  try {
    // Check for SimpleFin lump-sum deposit to replace
    const simpleFinMatch = await findSimpleFinDeposit(depositAccountGuid, netPay, payDate);
    if (simpleFinMatch) {
      // Period lock: the matched deposit's own date may differ from payDate
      await assertTxnMutable(bookGuid, simpleFinMatch);
    }

    transactionGuid = await prisma.$transaction(async (tx) => {
      // Dedup INSIDE the transaction (mirrors invoice-engine's payment
      // idempotency re-check): a retry that raced the claim TTL sees the
      // committed transaction here instead of writing a second one.
      const existingGuid = await findMatchingTransaction(splits, payDate, tx);
      if (existingGuid) {
        // Link payslip to existing transaction instead of creating a duplicate
        await tx.gnucash_web_payslips.update({
          where: { id: payslipId },
          data: {
            status: 'posted',
            transaction_guid: existingGuid,
            deposit_account_guid: depositAccountGuid,
            updated_at: new Date(),
          },
        });

        // Mark the existing transaction as payslip-verified
        const existingMeta = await tx.gnucash_web_transaction_meta.findUnique({
          where: { transaction_guid: existingGuid },
        });
        if (existingMeta) {
          await tx.gnucash_web_transaction_meta.update({
            where: { transaction_guid: existingGuid },
            data: {
              match_type: 'payslip_verified',
              match_confidence: 'high',
              matched_at: new Date(),
            },
          });
        } else {
          await tx.gnucash_web_transaction_meta.create({
            data: {
              transaction_guid: existingGuid,
              source: 'payslip',
              reviewed: true,
              match_type: 'payslip_verified',
              match_confidence: 'high',
              matched_at: new Date(),
            },
          });
        }

        await upsertTemplate(bookGuid, employerName, templateItems, tx);
        return existingGuid;
      }

      // Replace SimpleFin lump-sum deposit with detailed payslip splits
      if (simpleFinMatch) {
        // Delete the old lump-sum splits
        await tx.$executeRaw`DELETE FROM splits WHERE tx_guid = ${simpleFinMatch}`;

        // Update the transaction description
        await tx.$executeRaw`
          UPDATE transactions SET description = ${`Payslip: ${employerName}`}
          WHERE guid = ${simpleFinMatch}
        `;

        // Insert detailed payslip splits
        for (const split of splits) {
          const splitGuid = generateGuid();
          const { num, denom } = fromDecimal(split.amount);
          await tx.$executeRaw`
            INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
            VALUES (${splitGuid}, ${simpleFinMatch}, ${split.accountGuid}, ${split.memo}, '', 'n', NULL, ${num}, ${denom}, ${num}, ${denom}, NULL)
          `;
        }

        // Link payslip to the existing transaction
        await tx.gnucash_web_payslips.update({
          where: { id: payslipId },
          data: {
            status: 'posted',
            transaction_guid: simpleFinMatch,
            deposit_account_guid: depositAccountGuid,
            updated_at: new Date(),
          },
        });

        // Update meta to payslip_verified
        await tx.gnucash_web_transaction_meta.update({
          where: { transaction_guid: simpleFinMatch },
          data: {
            match_type: 'payslip_verified',
            match_confidence: 'high',
            matched_at: new Date(),
          },
        });

        // Auto-save template
        await upsertTemplate(bookGuid, employerName, templateItems, tx);

        return simpleFinMatch;
      }

      // No match — create new transaction
      const newGuid = generateGuid();
      const postDate = new Date(payDate + 'T12:00:00Z');
      const enterDate = new Date();
      const description = `Payslip: ${employerName}`;

      await tx.$executeRaw`
        INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
        VALUES (${newGuid}, ${currencyGuid}, '', ${postDate}, ${enterDate}, ${description})
      `;

      for (const split of splits) {
        const splitGuid = generateGuid();
        const { num, denom } = fromDecimal(split.amount);

        await tx.$executeRaw`
          INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
          VALUES (${splitGuid}, ${newGuid}, ${split.accountGuid}, ${split.memo}, '', 'n', NULL, ${num}, ${denom}, ${num}, ${denom}, NULL)
        `;
      }

      // Mark payslip as posted
      await tx.gnucash_web_payslips.update({
        where: { id: payslipId },
        data: {
          status: 'posted',
          transaction_guid: newGuid,
          deposit_account_guid: depositAccountGuid,
          updated_at: new Date(),
        },
      });

      // Record transaction meta (source: payslip)
      await tx.gnucash_web_transaction_meta.create({
        data: {
          transaction_guid: newGuid,
          source: 'payslip',
          reviewed: true,
        },
      });

      // Auto-save employer template from posted line items
      await upsertTemplate(bookGuid, employerName, templateItems, tx);

      return newGuid;
    }, {
      // The dedup scan now runs inside the transaction; the 5s Prisma default
      // is too tight for a book with many same-day candidate transactions.
      maxWait: 10_000,
      timeout: 30_000,
    });
  } catch (error) {
    // Hand the claim back so a legitimate retry can proceed immediately.
    await releasePayslipClaim(payslipId, priorStatus);
    throw error;
  }

  await linkPostedPayslip(bookGuid, payslipId, transactionGuid);
  return transactionGuid;
}
