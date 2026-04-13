/**
 * Core payslip extraction logic — no BullMQ dependency.
 * Called by both the BullMQ job handler (worker) and the upload route (inline fallback).
 */

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

    const resolvedBookGuid = bookGuid ?? payslip.book_guid;

    // Get PDF from storage
    const { getStorageBackend } = await import('@/lib/storage/storage-backend');
    const storage = await getStorageBackend();
    const buffer = await storage.get(payslip.storage_key);

    // Extract OCR text from PDF
    const { extractTextFromPdf } = await import('@/lib/queue/jobs/ocr-receipt');
    const ocrText = await extractTextFromPdf(buffer);

    // Run regex extraction for top-level fields
    const { extractPayslipFields, applyTemplateWithRegex } = await import('@/lib/payslip-regex');
    const regexFields = extractPayslipFields(ocrText);

    // Get AI config
    const { getAiConfig } = await import('@/lib/ai-config');
    const aiConfig = await getAiConfig(payslip.created_by ?? 0);

    // ── Tier 1: AI extraction (vision first, then OCR text) ─────────────
    if (aiConfig?.enabled && aiConfig.base_url && aiConfig.model) {
      try {
        const { extractPayslipWithVision, extractPayslipData } = await import('@/lib/payslip-extraction');

        let extractedData;
        let tier = 'ai_vision';

        try {
          console.log(`${logPrefix} Trying vision extraction...`);
          extractedData = await extractPayslipWithVision(buffer, aiConfig);
          console.log(`${logPrefix} Vision extraction succeeded`);
        } catch (visionErr) {
          console.log(`${logPrefix} Vision failed, trying OCR text:`, visionErr instanceof Error ? visionErr.message : visionErr);
          extractedData = await extractPayslipData(ocrText, aiConfig);
          tier = 'ai_text';
        }

        await updatePayslipLineItems(payslipId, extractedData.line_items, { ocrText, tier });

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
        return;
      } catch (aiErr) {
        console.warn(`${logPrefix} Tier 1 (AI) failed, falling through to Tier 2:`, aiErr);
      }
    }

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
      const templateLineItems = (template.line_items as Array<{ normalized_label: string; category: string }>) ?? [];
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
  } catch (err) {
    console.error(`${logPrefix} Payslip extraction failed:`, err);
    await updatePayslipStatus(payslipId, 'error', {
      error_message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
