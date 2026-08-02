/**
 * Statement ingestion orchestrator — no BullMQ dependency.
 * Called by both the BullMQ job handler (worker) and the upload route
 * (inline fallback), exactly like src/lib/payslip-extract-core.ts.
 *
 * Flow: load batch → fetch file from storage → parse (deterministic for
 * csv/ofx, PDF text-extract + AI for pdf) → replaceLines → set dates /
 * balances / currency + status 'parsed' (or 'error' with a message).
 *
 * This function NEVER throws — the worker relies on that (failures are
 * recorded on the batch row as status='error').
 *
 * AMOUNT SIGN CONVENTION (shared): positive = money INTO the account.
 */

import type { ParsedStatement } from './statement-parse/csv-ofx';
import type { BatchStatusPatch, StatementBatch, StatementLineInput } from './services/statement.service';
import { createHash } from 'node:crypto';
import { linkDocument, upsertDocument } from './documents';

function toLineInputs(parsed: ParsedStatement): StatementLineInput[] {
  return parsed.lines.map((l) => ({
    date: l.date,
    description: l.description,
    amount: l.amount,
    runningBalance: l.runningBalance ?? null,
  }));
}

export async function runStatementExtraction(
  batchId: number,
  bookGuid?: string,
  logPrefix: string = '[statement]',
  userId?: number,
): Promise<void> {
  const {
    getBatch,
    setBatchStatus,
    replaceLines,
    upsertStatementAcctMap,
    getMappedAccountGuid,
  } = await import('./services/statement.service');

  let batch: StatementBatch | null = null;
  try {
    batch = await getBatch(batchId);
    if (!batch) {
      console.warn(`${logPrefix} Statement batch ${batchId} not found, skipping`);
      return;
    }
    if (!batch.storageKey) {
      await setBatchStatus(batchId, 'error', { error: `Batch ${batchId} has no storage_key` });
      return;
    }

    await setBatchStatus(batchId, 'parsing');

    const { getStorageBackend } = await import('./storage/storage-backend');
    const storage = await getStorageBackend();
    const buffer = await storage.get(batch.storageKey);

    let parsed: ParsedStatement;

    if (batch.source === 'csv') {
      const { parseStatementCsv } = await import('./statement-parse/csv-ofx');
      parsed = parseStatementCsv(buffer.toString('utf-8'));
      if (parsed.lines.length === 0) {
        throw new Error('No transactions found in CSV (unrecognized columns or empty file)');
      }
    } else if (batch.source === 'ofx') {
      const { parseStatementOfx } = await import('./statement-parse/csv-ofx');
      parsed = parseStatementOfx(buffer.toString('utf-8'));
      if (parsed.lines.length === 0) {
        throw new Error('No transactions found in OFX/QFX file');
      }
    } else {
      // PDF → extract text → AI
      const { extractTextFromPdf } = await import('./pdf-text-extract');
      let text = '';
      try {
        text = await extractTextFromPdf(buffer);
      } catch (err) {
        throw new Error(
          `Failed to extract text from PDF: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const { getAiConfig } = await import('./ai-config');
      const aiConfig = await getAiConfig(userId ?? 0);

      const { extractStatementFromText } = await import('./statement-parse/ai-extract');
      parsed = await extractStatementFromText(text, { aiConfig });
      if (parsed.lines.length === 0) {
        throw new Error('AI extraction returned no transactions');
      }
    }

    const lines = toLineInputs(parsed);
    await replaceLines(batchId, lines);

    const parsedPatch: BatchStatusPatch = {
      statementStartDate: parsed.startDate ?? null,
      statementEndDate: parsed.endDate ?? null,
      openingBalance: parsed.openingBalance ?? null,
      closingBalance: parsed.closingBalance ?? null,
      currency: parsed.currency ?? null,
      error: null,
    };

    // OFX account auto-detect: persist the detected <ACCTID>, remember the
    // pairing when the batch already has an account, or auto-assign the
    // account when a previously-remembered pairing exists for this book.
    if (batch.source === 'ofx') {
      const { planOfxAccountActions, normalizeOfxAcctId } = await import(
        './statement-parse/ofx-account'
      );
      const normalizedId = normalizeOfxAcctId(parsed.acctId);
      const mappedAccountGuid =
        !batch.accountGuid && normalizedId
          ? await getMappedAccountGuid(batch.bookGuid, normalizedId)
          : null;
      const plan = planOfxAccountActions({
        rawAcctId: parsed.acctId ?? null,
        batchAccountGuid: batch.accountGuid,
        mappedAccountGuid,
      });
      parsedPatch.ofxAcctId = plan.ofxAcctId;
      if (plan.assignAccountGuid) {
        parsedPatch.accountGuid = plan.assignAccountGuid;
        console.log(
          `${logPrefix} Auto-assigned account ${plan.assignAccountGuid} to batch ${batchId} via OFX ACCTID mapping`,
        );
      }
      if (plan.ofxAcctId && plan.rememberAccountGuid) {
        try {
          await upsertStatementAcctMap(batch.bookGuid, plan.ofxAcctId, plan.rememberAccountGuid);
        } catch (mapErr) {
          console.warn(`${logPrefix} Failed to upsert OFX account map:`, mapErr);
        }
      }
    }

    await setBatchStatus(batchId, 'parsed', parsedPatch);

    try {
      const canonical = await upsertDocument({
        bookGuid: batch.bookGuid,
        ownerUserId: userId ?? null,
        title: batch.originalFilename.slice(0, 255),
        storageKey: batch.storageKey,
        filename: batch.originalFilename.slice(0, 255),
        mimeType: batch.source === 'pdf'
          ? 'application/pdf'
          : batch.source === 'csv'
            ? 'text/csv'
            : 'application/x-ofx',
        sizeBytes: buffer.byteLength,
        contentHash: createHash('sha256').update(buffer).digest('hex'),
        extractionStatus: 'completed',
        extractedText: lines.map((line) => line.description).join('\n'),
        extractionMetadata: {
          source: batch.source,
          lineCount: lines.length,
          statementStartDate: parsed.startDate ?? null,
          statementEndDate: parsed.endDate ?? null,
          openingBalance: parsed.openingBalance ?? null,
          closingBalance: parsed.closingBalance ?? null,
          currency: parsed.currency ?? null,
        },
        extractedAt: new Date(),
        sourceKind: 'statement_batch',
        sourceId: String(batch.id),
      });

      const accountGuid = parsedPatch.accountGuid ?? batch.accountGuid;
      if (accountGuid) {
        await linkDocument({
          bookGuid: batch.bookGuid,
          documentId: canonical.id,
          targetType: 'account',
          targetId: accountGuid,
          role: 'statement',
          metadata: { autoSource: 'gnucash_web_statement_batches.account_guid' },
        });
      }
    } catch (canonicalError) {
      const detail = canonicalError instanceof Error
        ? canonicalError.message.slice(0, 500)
        : String(canonicalError).slice(0, 500);
      console.warn(`${logPrefix} Canonical statement sync deferred for batch ${batchId}: ${detail}`);
    }

    console.log(`${logPrefix} Parsed ${lines.length} line(s) from ${batch.source} batch ${batchId}`);
  } catch (err) {
    console.error(`${logPrefix} Statement extraction failed:`, err);
    try {
      await setBatchStatus(batchId, 'error', {
        error: err instanceof Error ? err.message : String(err),
      });
    } catch (statusErr) {
      console.error(`${logPrefix} Failed to record error status:`, statusErr);
    }
    if (batch) {
      try {
        await upsertDocument({
          bookGuid: batch.bookGuid,
          ownerUserId: userId ?? null,
          title: batch.originalFilename.slice(0, 255),
          storageKey: batch.storageKey,
          filename: batch.originalFilename.slice(0, 255),
          mimeType: batch.source === 'pdf'
            ? 'application/pdf'
            : batch.source === 'csv'
              ? 'text/csv'
              : 'application/x-ofx',
          extractionStatus: 'failed',
          extractionError: err instanceof Error ? err.message : String(err),
          sourceKind: 'statement_batch',
          sourceId: String(batch.id),
        });
      } catch (indexError) {
        console.error(`${logPrefix} Failed to sync canonical document error state:`, indexError);
      }
    }
    // Deliberately do NOT rethrow — the worker treats this as handled.
  }
}
