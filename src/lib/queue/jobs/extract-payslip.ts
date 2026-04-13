import { Job } from 'bullmq';

export async function handleExtractPayslip(job: Job): Promise<void> {
  const { payslipId, bookGuid } = job.data as { payslipId: number; bookGuid?: string };
  console.log(`[Job ${job.id}] Starting payslip extraction for ${payslipId}`);

  const { updatePayslipStatus, updatePayslipLineItems, getMappingsForEmployer } = await import('@/lib/payslips');

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

    // Get PDF from storage
    const { getStorageBackend } = await import('@/lib/storage/storage-backend');
    const storage = await getStorageBackend();
    const buffer = await storage.get(payslip.storage_key);

    // Extract text from PDF
    const { extractTextFromPdf } = await import('./ocr-receipt');
    const ocrText = await extractTextFromPdf(buffer);

    // Get AI config for the payslip creator
    const { getAiConfig } = await import('@/lib/ai-config');
    const aiConfig = await getAiConfig(payslip.created_by ?? 0);

    if (!aiConfig || !aiConfig.enabled) {
      throw new Error('AI provider is not configured. Please configure an AI provider in settings.');
    }

    // Extract structured payslip data
    const { extractPayslipData } = await import('@/lib/payslip-extraction');
    const extractedData = await extractPayslipData(ocrText, aiConfig);

    // Update payslip with extracted line items
    await updatePayslipLineItems(payslipId, extractedData.line_items);

    // Update status to 'needs_mapping' with extracted metadata
    const resolvedBookGuid = bookGuid ?? payslip.book_guid;
    await updatePayslipStatus(payslipId, 'needs_mapping', {
      employer_name: extractedData.employer_name,
      pay_date: extractedData.pay_date ? new Date(extractedData.pay_date) : undefined,
      pay_period_start: extractedData.pay_period_start ? new Date(extractedData.pay_period_start) : undefined,
      pay_period_end: extractedData.pay_period_end ? new Date(extractedData.pay_period_end) : undefined,
      gross_pay: extractedData.gross_pay,
      net_pay: extractedData.net_pay,
    });

    console.log(`[Job ${job.id}] Payslip extraction complete: ${extractedData.line_items.length} line items, employer: ${extractedData.employer_name}`);

    // Check if all line items have existing mappings → if yes, set status to 'ready'
    const mappings = await getMappingsForEmployer(resolvedBookGuid, extractedData.employer_name);
    const mappingIndex = new Set(
      mappings.map((m) => `${m.normalized_label}::${m.line_item_category}`)
    );

    const allMapped = extractedData.line_items.every((item) =>
      mappingIndex.has(`${item.normalized_label}::${item.category}`)
    );

    if (allMapped && extractedData.line_items.length > 0) {
      await updatePayslipStatus(payslipId, 'ready');
      console.log(`[Job ${job.id}] All line items mapped — payslip ${payslipId} set to ready`);
    }
  } catch (err) {
    console.error(`[Job ${job.id}] Payslip extraction failed:`, err);
    await updatePayslipStatus(payslipId, 'error', {
      error_message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
