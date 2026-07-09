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
import type { StatementLineInput } from './services/statement.service';

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
  } = await import('./services/statement.service');

  try {
    const batch = await getBatch(batchId);
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

    await setBatchStatus(batchId, 'parsed', {
      statementStartDate: parsed.startDate ?? null,
      statementEndDate: parsed.endDate ?? null,
      openingBalance: parsed.openingBalance ?? null,
      closingBalance: parsed.closingBalance ?? null,
      currency: parsed.currency ?? null,
      error: null,
    });

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
    // Deliberately do NOT rethrow — the worker treats this as handled.
  }
}
