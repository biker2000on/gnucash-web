import { Job } from 'bullmq';

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

export async function handleExtractPayslip(job: Job): Promise<void> {
  const { payslipId, bookGuid: jobBookGuid } = job.data as { payslipId: number; bookGuid?: string };
  console.log(`[Job ${job.id}] Starting payslip extraction for ${payslipId}`);

  const { updatePayslipStatus, updatePayslipLineItems } = await import('@/lib/payslips');

  try {
    await updatePayslipStatus(payslipId, 'processing');

    // Look up payslip from DB via Prisma
    const prisma = (await import('@/lib/prisma')).default;
    const payslip = await prisma.gnucash_web_payslips.findFirst({
      where: { id: payslipId },
    });

    if (!payslip) {
      console.warn(`[Job ${job.id}] Payslip ${payslipId} not found, skipping extraction`);
      await updatePayslipStatus(payslipId, 'error', {
        error_message: `Payslip ${payslipId} not found`,
      });
      return;
    }

    if (!payslip.storage_key) {
      throw new Error(`Payslip ${payslipId} has no storage_key`);
    }

    const resolvedBookGuid = jobBookGuid ?? payslip.book_guid;

    // Get PDF from storage
    const { getStorageBackend } = await import('@/lib/storage/storage-backend');
    const storage = await getStorageBackend();
    const buffer = await storage.get(payslip.storage_key);

    // Extract OCR text from PDF
    const { extractTextFromPdf } = await import('./ocr-receipt');
    const ocrText = await extractTextFromPdf(buffer);

    // Run regex extraction for top-level fields (employer, dates, gross/net)
    const { extractPayslipFields, applyTemplateWithRegex } = await import('@/lib/payslip-regex');
    const regexFields = extractPayslipFields(ocrText);

    // Get AI config
    const { getAiConfig } = await import('@/lib/ai-config');
    const aiConfig = await getAiConfig(payslip.created_by ?? 0);

    // ── Tier 1: AI extraction ──────────────────────────────────────────────
    if (aiConfig?.enabled && aiConfig.base_url && aiConfig.model) {
      try {
        const { extractPayslipData } = await import('@/lib/payslip-extraction');
        const extractedData = await extractPayslipData(ocrText, aiConfig);

        // Update line items with AI results
        await updatePayslipLineItems(payslipId, extractedData.line_items, { ocrText, tier: 'ai' });

        // Update status with extracted metadata
        await updatePayslipStatus(payslipId, 'needs_mapping', {
          employer_name: extractedData.employer_name,
          pay_date: extractedData.pay_date ? new Date(extractedData.pay_date) : undefined,
          pay_period_start: extractedData.pay_period_start ? new Date(extractedData.pay_period_start) : undefined,
          pay_period_end: extractedData.pay_period_end ? new Date(extractedData.pay_period_end) : undefined,
          gross_pay: extractedData.gross_pay,
          net_pay: extractedData.net_pay,
        });

        // Auto-save template (strip amounts from line items)
        const { upsertTemplate } = await import('@/lib/payslips');
        const templateLineItems = extractedData.line_items.map(({ normalized_label, category }) => ({
          normalized_label,
          category,
        }));
        await upsertTemplate(resolvedBookGuid, extractedData.employer_name, templateLineItems);

        console.log(`[Job ${job.id}] Tier 1 (AI) complete: ${extractedData.line_items.length} line items, employer: ${extractedData.employer_name}`);

        await checkMappingsAndSetReady(payslipId, resolvedBookGuid, extractedData.employer_name, extractedData.line_items);
        return;
      } catch (aiErr) {
        console.warn(`[Job ${job.id}] Tier 1 (AI) failed, falling through to Tier 2:`, aiErr);
      }
    }

    // ── Tier 2: Template + regex ───────────────────────────────────────────
    const employerName = regexFields.employer_name ?? 'Unknown';
    const { getTemplate } = await import('@/lib/payslips');

    let template = await getTemplate(resolvedBookGuid, employerName);

    // If no exact match and employer is unknown, try the only template in the book
    if (!template && employerName === 'Unknown') {
      const allTemplates = await prisma.gnucash_web_payslip_templates.findMany({
        where: { book_guid: resolvedBookGuid },
      });
      if (allTemplates.length === 1) {
        template = allTemplates[0];
      }
    }

    if (template) {
      const templateLineItems = (template.line_items as Array<{ normalized_label: string; category: string }>) ?? [];
      const appliedLineItems = applyTemplateWithRegex(templateLineItems, ocrText);

      await updatePayslipLineItems(payslipId, appliedLineItems, { ocrText, tier: 'template_regex' });

      await updatePayslipStatus(payslipId, 'needs_mapping', {
        employer_name: regexFields.employer_name ?? undefined,
        pay_date: regexFields.pay_date ? new Date(regexFields.pay_date) : undefined,
        pay_period_start: regexFields.pay_period_start ? new Date(regexFields.pay_period_start) : undefined,
        pay_period_end: regexFields.pay_period_end ? new Date(regexFields.pay_period_end) : undefined,
        gross_pay: regexFields.gross_pay,
        net_pay: regexFields.net_pay,
      });

      console.log(`[Job ${job.id}] Tier 2 (template+regex) complete: ${appliedLineItems.length} line items, employer: ${employerName}`);

      await checkMappingsAndSetReady(payslipId, resolvedBookGuid, employerName, appliedLineItems);
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

    console.log(`[Job ${job.id}] Tier 3 (regex-only) complete: no template found, user will manually add line items`);
  } catch (err) {
    console.error(`[Job ${job.id}] Payslip extraction failed:`, err);
    await updatePayslipStatus(payslipId, 'error', {
      error_message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
