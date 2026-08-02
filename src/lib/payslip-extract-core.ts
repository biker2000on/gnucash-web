/**
 * Core payslip extraction logic — no BullMQ dependency.
 * Called by both the BullMQ job handler (worker) and the upload route (inline fallback).
 */

import { createHash } from 'node:crypto';
import { linkDocument, upsertDocument } from '@/lib/documents';

async function syncPayslipDocument(
  payslipId: number,
  bookGuid: string,
  buffer: Buffer | null,
  extractedText: string | null,
  extractionError?: string | null,
): Promise<void> {
  try {
    const prisma = (await import('@/lib/prisma')).default;
    const row = await prisma.gnucash_web_payslips.findFirst({
      where: { id: payslipId, book_guid: bookGuid },
    });
    if (!row) return;
    const canonical = await upsertDocument({
      bookGuid,
      ownerUserId: row.created_by,
      title: row.employer_name,
      storageKey: row.storage_key,
      filename: `payslip-${payslipId}.pdf`,
      mimeType: row.storage_key ? 'application/pdf' : null,
      sizeBytes: buffer?.byteLength ?? null,
      contentHash: buffer ? createHash('sha256').update(buffer).digest('hex') : null,
      extractionStatus: extractionError ? 'failed' : 'completed',
      extractedText,
      extractionMetadata: {
        employerName: row.employer_name,
        payDate: row.pay_date?.toISOString().slice(0, 10) ?? null,
        payPeriodStart: row.pay_period_start?.toISOString().slice(0, 10) ?? null,
        payPeriodEnd: row.pay_period_end?.toISOString().slice(0, 10) ?? null,
        lineItems: row.line_items,
        rawResponse: row.raw_response,
        status: row.status,
      },
      extractionError: extractionError ?? null,
      extractedAt: extractionError ? null : new Date(),
      sourceKind: 'payslip',
      sourceId: String(payslipId),
    });
    if (row.transaction_guid) {
      await linkDocument({
        bookGuid,
        documentId: canonical.id,
        targetType: 'transaction',
        targetId: row.transaction_guid,
        role: 'payslip',
        metadata: { autoSource: 'gnucash_web_payslips.transaction_guid' },
      });
    }
  } catch (canonicalError) {
    const detail = canonicalError instanceof Error
      ? canonicalError.message.slice(0, 500)
      : String(canonicalError).slice(0, 500);
    console.warn(`[payslip ${payslipId}] Canonical sync deferred: ${detail}`);
  }
}

async function checkMappingsAndSetReady(
  payslipId: number,
  bookGuid: string,
  employerName: string,
  lineItems: Array<{ normalized_label: string; category: string }>,
) {
  if (lineItems.length === 0) return;
  const { updatePayslipStatus, getMappingsForEmployer } = await import('@/lib/payslips');
  const mappings = await getMappingsForEmployer(bookGuid, employerName);
  const mappingIndex = new Set(mappings.map(m => `${m.normalized_label}::${m.line_item_category}`));
  const allMapped = lineItems.every(item => mappingIndex.has(`${item.normalized_label}::${item.category}`));
  if (allMapped) {
    await updatePayslipStatus(payslipId, 'ready');
  }
}

export async function runPayslipExtraction(
  payslipId: number,
  bookGuid?: string,
  logPrefix: string = '[extract]'
): Promise<void> {
  const { updatePayslipStatus, updatePayslipLineItems } = await import('@/lib/payslips');
  let resolvedBookGuid = bookGuid;
  let sourceBuffer: Buffer | null = null;

  try {
    await updatePayslipStatus(payslipId, 'processing');

    const prisma = (await import('@/lib/prisma')).default;
    const payslip = await prisma.gnucash_web_payslips.findFirst({
      where: { id: payslipId },
    });

    if (!payslip) {
      console.warn(`${logPrefix} Payslip ${payslipId} not found, skipping`);
      await updatePayslipStatus(payslipId, 'error', {
        error_message: `Payslip ${payslipId} not found`,
      });
      return;
    }

    if (!payslip.storage_key) {
      throw new Error(`Payslip ${payslipId} has no storage_key`);
    }

    resolvedBookGuid = bookGuid ?? payslip.book_guid;

    // Get PDF from storage
    const { getStorageBackend } = await import('@/lib/storage/storage-backend');
    const storage = await getStorageBackend();
    const buffer = await storage.get(payslip.storage_key);
    sourceBuffer = buffer;

    // Get AI config
    const { getAiConfig } = await import('@/lib/ai-config');
    const aiConfig = await getAiConfig(payslip.created_by ?? 0);

    // ── Tier 1: AI extraction (vision — sends rendered PDF image) ───────
    if (aiConfig?.enabled && aiConfig.base_url && aiConfig.model) {
      try {
        const { extractPayslipWithVision } = await import('@/lib/payslip-extraction');

        console.log(`${logPrefix} Trying vision extraction...`);
        const extractedData = await extractPayslipWithVision(buffer, aiConfig);
        console.log(`${logPrefix} Vision extraction succeeded`);

        await updatePayslipLineItems(payslipId, extractedData.line_items, { tier: 'ai_vision' });

        await updatePayslipStatus(payslipId, 'needs_mapping', {
          employer_name: extractedData.employer_name,
          pay_date: extractedData.pay_date ? new Date(extractedData.pay_date) : undefined,
          pay_period_start: extractedData.pay_period_start ? new Date(extractedData.pay_period_start) : undefined,
          pay_period_end: extractedData.pay_period_end ? new Date(extractedData.pay_period_end) : undefined,
          gross_pay: extractedData.gross_pay,
          net_pay: extractedData.net_pay,
        });

        const { upsertTemplate } = await import('@/lib/payslips');
        const templateLineItems = extractedData.line_items.map(({ label, normalized_label, category }) => ({
          label, normalized_label, category,
        }));
        await upsertTemplate(resolvedBookGuid, extractedData.employer_name, templateLineItems);

        console.log(`${logPrefix} Tier 1 (AI) complete: ${extractedData.line_items.length} line items, employer: ${extractedData.employer_name}`);

        await checkMappingsAndSetReady(payslipId, resolvedBookGuid, extractedData.employer_name, extractedData.line_items);
        await syncPayslipDocument(
          payslipId,
          resolvedBookGuid,
          buffer,
          JSON.stringify(extractedData),
        );
        return;
      } catch (aiErr) {
        console.warn(`${logPrefix} Tier 1 (AI) failed, falling through to Tier 2:`, aiErr);
      }
    }

    // ── Tiers 2 & 3 need OCR text for regex extraction ───────────────────
    let ocrText = '';
    try {
      const { extractTextFromPdf } = await import('@/lib/pdf-text-extract');
      ocrText = await extractTextFromPdf(buffer);
    } catch (ocrErr) {
      console.warn(`${logPrefix} OCR text extraction failed:`, ocrErr instanceof Error ? ocrErr.message : ocrErr);
    }

    const { extractPayslipFields, applyTemplateWithRegex } = await import('@/lib/payslip-regex');
    const regexFields = extractPayslipFields(ocrText);

    // ── Tier 2: Template + regex ───────────────────────────────────────────
    const employerName = regexFields.employer_name ?? 'Unknown';
    const { getTemplate } = await import('@/lib/payslips');

    let template = await getTemplate(resolvedBookGuid, employerName);

    if (!template) {
      const allTemplates = await prisma.gnucash_web_payslip_templates.findMany({
        where: { book_guid: resolvedBookGuid },
      });

      const lowerName = employerName.toLowerCase();
      template = allTemplates.find(t => t.employer_name.toLowerCase() === lowerName) ?? null;

      if (!template && allTemplates.length === 1) {
        template = allTemplates[0];
        console.log(`${logPrefix} Using sole template for book: "${template.employer_name}"`);
      }
    }

    if (template) {
      const rawLineItems = (template.line_items as Array<{ normalized_label: string; category: string; label?: string }>) ?? [];
      const templateLineItems = rawLineItems.map(item => ({
        ...item,
        label: item.label || item.normalized_label,
      }));
      const appliedLineItems = applyTemplateWithRegex(templateLineItems, ocrText);

      await updatePayslipLineItems(payslipId, appliedLineItems, { ocrText, tier: 'template_regex' });

      const resolvedEmployer = template.employer_name;
      await updatePayslipStatus(payslipId, 'needs_mapping', {
        employer_name: resolvedEmployer,
        pay_date: regexFields.pay_date ? new Date(regexFields.pay_date) : undefined,
        pay_period_start: regexFields.pay_period_start ? new Date(regexFields.pay_period_start) : undefined,
        pay_period_end: regexFields.pay_period_end ? new Date(regexFields.pay_period_end) : undefined,
        gross_pay: regexFields.gross_pay,
        net_pay: regexFields.net_pay,
      });

      console.log(`${logPrefix} Tier 2 (template+regex) complete: ${appliedLineItems.length} line items, employer: ${resolvedEmployer}`);

      await checkMappingsAndSetReady(payslipId, resolvedBookGuid, resolvedEmployer, appliedLineItems);
      await syncPayslipDocument(payslipId, resolvedBookGuid, buffer, ocrText);
      return;
    }

    // ── Tier 3: Regex-only (manual entry) ─────────────────────────────────
    await updatePayslipLineItems(payslipId, [], { ocrText, tier: 'regex_only' });

    await updatePayslipStatus(payslipId, 'needs_mapping', {
      employer_name: regexFields.employer_name ?? undefined,
      pay_date: regexFields.pay_date ? new Date(regexFields.pay_date) : undefined,
      pay_period_start: regexFields.pay_period_start ? new Date(regexFields.pay_period_start) : undefined,
      pay_period_end: regexFields.pay_period_end ? new Date(regexFields.pay_period_end) : undefined,
      gross_pay: regexFields.gross_pay,
      net_pay: regexFields.net_pay,
    });

    console.log(`${logPrefix} Tier 3 (regex-only) complete: no template found, user will manually add line items`);
    await syncPayslipDocument(payslipId, resolvedBookGuid, buffer, ocrText);
  } catch (err) {
    console.error(`${logPrefix} Payslip extraction failed:`, err);
    await updatePayslipStatus(payslipId, 'error', {
      error_message: err instanceof Error ? err.message : String(err),
    });
    if (resolvedBookGuid) {
      try {
        await syncPayslipDocument(
          payslipId,
          resolvedBookGuid,
          sourceBuffer,
          null,
          err instanceof Error ? err.message : String(err),
        );
      } catch { /* syncPayslipDocument is best effort */ }
    }
    throw err;
  }
}
