import { query } from '@/lib/db';
import { getAiConfig } from '@/lib/ai-config';
import {
  extractReceiptData,
  type AiConfig,
  type ExtractedData,
} from '@/lib/receipt-extraction';

interface ReceiptExtractionRow {
  id: number;
  filename: string;
  ocr_text: string;
  extracted_data: Record<string, unknown> | null;
}

export interface ReceiptReextractSummary {
  eligible: number;
  processed: number;
  upgraded: number;
  fallback: number;
  failed: number;
}

export interface ReceiptReextractProgress {
  current: number;
  total: number;
  percent: number;
  message: string;
}

export function shouldReextractReceipt(
  extractedData: Record<string, unknown> | null,
  force: boolean,
): boolean {
  if (force) return true;
  const method = extractedData?.extraction_method;
  return method == null || method === 'regex' || method === 'ai_fallback_regex';
}

/** Preserve user workflow metadata such as dismissed match GUIDs. */
export function mergeReceiptExtraction(
  previous: Record<string, unknown> | null,
  extracted: ExtractedData,
): Record<string, unknown> {
  return { ...(previous ?? {}), ...extracted };
}

function assertAiConfigured(config: AiConfig | null): asserts config is AiConfig {
  if (!config?.enabled || !config.base_url || !config.model) {
    throw new Error('AI extraction is not configured for this user.');
  }
}

export async function countReceiptReextractCandidates(
  bookGuid: string,
  force = false,
): Promise<number> {
  const result = await query(
    `SELECT COUNT(*)::int AS count
     FROM gnucash_web_receipts
     WHERE book_guid = $1
       AND ocr_status = 'complete'
       AND NULLIF(BTRIM(ocr_text), '') IS NOT NULL
       AND (
         $2::boolean
         OR extracted_data IS NULL
         OR extracted_data->>'extraction_method' IS NULL
         OR extracted_data->>'extraction_method' IN ('regex', 'ai_fallback_regex')
       )`,
    [bookGuid, force],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function runReceiptReextraction(options: {
  bookGuid: string;
  userId: number;
  force?: boolean;
  onProgress?: (progress: ReceiptReextractProgress) => void | Promise<void>;
}): Promise<ReceiptReextractSummary> {
  const force = options.force === true;
  const aiConfig = await getAiConfig(options.userId);
  assertAiConfigured(aiConfig);

  const result = await query(
    `SELECT id, filename, ocr_text, extracted_data
     FROM gnucash_web_receipts
     WHERE book_guid = $1
       AND ocr_status = 'complete'
       AND NULLIF(BTRIM(ocr_text), '') IS NOT NULL
       AND (
         $2::boolean
         OR extracted_data IS NULL
         OR extracted_data->>'extraction_method' IS NULL
         OR extracted_data->>'extraction_method' IN ('regex', 'ai_fallback_regex')
       )
     ORDER BY id`,
    [options.bookGuid, force],
  );
  const receipts = result.rows as ReceiptExtractionRow[];
  const summary: ReceiptReextractSummary = {
    eligible: receipts.length,
    processed: 0,
    upgraded: 0,
    fallback: 0,
    failed: 0,
  };

  for (const [index, receipt] of receipts.entries()) {
    try {
      const extracted = await extractReceiptData(receipt.ocr_text, aiConfig);
      const merged = mergeReceiptExtraction(receipt.extracted_data, extracted);
      await query(
        `UPDATE gnucash_web_receipts
         SET extracted_data = $1, updated_at = NOW()
         WHERE id = $2 AND book_guid = $3`,
        [JSON.stringify(merged), receipt.id, options.bookGuid],
      );
      summary.processed += 1;
      if (extracted.extraction_method === 'ai') summary.upgraded += 1;
      else summary.fallback += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(
        `Receipt re-extraction failed for ${receipt.id}:`,
        error instanceof Error ? error.message : error,
      );
    }

    const current = index + 1;
    await options.onProgress?.({
      current,
      total: receipts.length,
      percent: receipts.length === 0 ? 100 : Math.round((current / receipts.length) * 100),
      message: `Re-extracting ${receipt.filename} (${current}/${receipts.length})`,
    });
  }

  return summary;
}
