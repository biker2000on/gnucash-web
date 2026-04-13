// src/lib/payslip-extraction.ts

import type { PayslipLineItem, PayslipLineItemCategory } from '@/lib/types';
import type { AiConfig } from '@/lib/receipt-extraction';

export type { AiConfig };

export interface PayslipExtractedData {
  employer_name: string;
  pay_date: string;
  pay_period_start?: string;
  pay_period_end?: string;
  gross_pay: number;
  net_pay: number;
  line_items: PayslipLineItem[];
}

const VALID_CATEGORIES: PayslipLineItemCategory[] = [
  'earnings',
  'tax',
  'deduction',
  'employer_contribution',
  'reimbursement',
];

/** Build system and user messages for AI payslip extraction. */
export function buildPayslipExtractionPrompt(ocrText: string): { system: string; user: string } {
  const system = `You are a payslip data extraction assistant. Extract structured data from payslip text and return ONLY valid JSON with no explanation.

The JSON must have these fields:
- employer_name (string): name of the employer
- pay_date (string): pay date in YYYY-MM-DD format
- pay_period_start (string, optional): start of pay period in YYYY-MM-DD format
- pay_period_end (string, optional): end of pay period in YYYY-MM-DD format
- gross_pay (number): total gross pay (positive)
- net_pay (number): total net pay / take-home pay (positive)
- line_items (array): each item has:
  - category: one of "earnings", "tax", "deduction", "employer_contribution", "reimbursement"
  - label (string): original label text from payslip
  - normalized_label (string): snake_case label, e.g. "Federal Income Tax" → "federal_income_tax", "401(k)" → "401k", "Regular Pay" → "regular_pay"
  - amount (number): positive for earnings/reimbursements/employer_contributions, negative for taxes/deductions
  - hours (number, optional): hours worked, only for hourly earnings lines
  - rate (number, optional): hourly rate, only for hourly earnings lines

normalized_label rules:
- Convert to lowercase snake_case
- Remove parentheses and special characters (except underscores)
- Replace spaces with underscores
- Examples: "Federal Income Tax" → "federal_income_tax", "Social Security" → "social_security", "401(k)" → "401k", "HSA Contribution" → "hsa_contribution"

Return ONLY valid JSON. No markdown, no explanation.`;

  return { system, user: ocrText };
}

/** Parse and validate an AI response string into PayslipExtractedData. */
export function parsePayslipAiResponse(raw: string): PayslipExtractedData {
  // Strip markdown code blocks if present
  const jsonStr = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Failed to parse AI response as JSON: ${raw.slice(0, 100)}`);
  }

  // Validate required fields
  const requiredFields = ['employer_name', 'pay_date', 'gross_pay', 'net_pay'];
  for (const field of requiredFields) {
    if (parsed[field] === undefined || parsed[field] === null) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  if (typeof parsed.employer_name !== 'string') {
    throw new Error('employer_name must be a string');
  }
  if (typeof parsed.pay_date !== 'string') {
    throw new Error('pay_date must be a string');
  }
  if (typeof parsed.gross_pay !== 'number') {
    throw new Error('gross_pay must be a number');
  }
  if (typeof parsed.net_pay !== 'number') {
    throw new Error('net_pay must be a number');
  }

  // Parse and validate line items
  const rawItems = Array.isArray(parsed.line_items) ? parsed.line_items : [];
  const line_items: PayslipLineItem[] = rawItems.map((item: unknown, idx: number) => {
    const i = item as Record<string, unknown>;
    if (!VALID_CATEGORIES.includes(i.category as PayslipLineItemCategory)) {
      throw new Error(`line_items[${idx}].category "${i.category}" is not a valid category`);
    }
    const lineItem: PayslipLineItem = {
      category: i.category as PayslipLineItemCategory,
      label: String(i.label ?? ''),
      normalized_label: String(i.normalized_label ?? ''),
      amount: typeof i.amount === 'number' ? i.amount : 0,
    };
    if (typeof i.hours === 'number') lineItem.hours = i.hours;
    if (typeof i.rate === 'number') lineItem.rate = i.rate;
    return lineItem;
  });

  const result: PayslipExtractedData = {
    employer_name: parsed.employer_name,
    pay_date: parsed.pay_date,
    gross_pay: parsed.gross_pay,
    net_pay: parsed.net_pay,
    line_items,
  };

  if (typeof parsed.pay_period_start === 'string') {
    result.pay_period_start = parsed.pay_period_start;
  }
  if (typeof parsed.pay_period_end === 'string') {
    result.pay_period_end = parsed.pay_period_end;
  }

  return result;
}

const VISION_PROMPT = `Extract structured data from this payslip image. Return ONLY valid JSON.

Fields: employer_name (string), pay_date (YYYY-MM-DD), pay_period_start (YYYY-MM-DD, optional), pay_period_end (YYYY-MM-DD, optional), gross_pay (number, CURRENT period NOT YTD), net_pay (number, CURRENT period NOT YTD), line_items (array) with: category (earnings/tax/deduction/employer_contribution/reimbursement), label (original text), normalized_label (snake_case), amount (positive for earnings, negative for taxes/deductions, use CURRENT column NOT YTD), hours (optional), rate (optional).

CRITICAL: Use the CURRENT period column values, NOT YTD (year-to-date) values. Return ONLY valid JSON, no markdown.`;

/**
 * Render a PDF buffer to a PNG image for vision extraction.
 * Uses pdftoppm (poppler-utils) for high-quality rendering.
 * Returns base64-encoded PNG string, or null if rendering fails.
 */
async function renderPdfToBase64(pdfBuffer: Buffer): Promise<string | null> {
  try {
    const { writeFileSync, readFileSync, readdirSync, unlinkSync } = await import('fs');
    const { execSync } = await import('child_process');
    const { tmpdir } = await import('os');
    const { join } = await import('path');

    const tmpDir = tmpdir();
    const inputPath = join(tmpDir, `payslip-input-${Date.now()}.pdf`);
    const outPrefix = join(tmpDir, `payslip-render-${Date.now()}`);

    writeFileSync(inputPath, pdfBuffer);
    execSync(`pdftoppm -f 1 -l 1 -png -r 300 ${inputPath} ${outPrefix}`, { timeout: 30000 });

    const files = readdirSync(tmpDir).filter(f => f.startsWith(`payslip-render-${Date.now().toString().slice(0, -3)}`));
    if (files.length === 0) return null;

    const imgBuffer = readFileSync(join(tmpDir, files[0]));

    // Cleanup
    try { unlinkSync(inputPath); } catch { /* ignore */ }
    try { unlinkSync(join(tmpDir, files[0])); } catch { /* ignore */ }

    return imgBuffer.toString('base64');
  } catch {
    return null;
  }
}

/**
 * Extract payslip data using vision (image-based) AI.
 * Renders the PDF to an image and sends it to a vision-capable model.
 */
export async function extractPayslipWithVision(
  pdfBuffer: Buffer,
  aiConfig: AiConfig
): Promise<PayslipExtractedData> {
  const base64 = await renderPdfToBase64(pdfBuffer);
  if (!base64) throw new Error('Failed to render PDF to image');

  const url = `${aiConfig.base_url!.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (aiConfig.api_key) headers['Authorization'] = `Bearer ${aiConfig.api_key}`;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(300000),
    body: JSON.stringify({
      model: aiConfig.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
        ],
      }],
      temperature: 0,
      max_tokens: 4000,
    }),
  });

  if (!response.ok) throw new Error(`Vision API error: ${response.status}`);

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty vision response');

  return parsePayslipAiResponse(content);
}

/** Extract payslip data from OCR text using AI (text-only fallback). */
export async function extractPayslipData(
  ocrText: string,
  aiConfig: AiConfig
): Promise<PayslipExtractedData> {
  if (!aiConfig.enabled || !aiConfig.base_url || !aiConfig.model) {
    throw new Error('AI config is not enabled or missing base_url/model');
  }

  const url = `${aiConfig.base_url.replace(/\/+$/, '')}/chat/completions`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (aiConfig.api_key) {
    headers['Authorization'] = `Bearer ${aiConfig.api_key}`;
  }

  const { system, user } = buildPayslipExtractionPrompt(ocrText);

  const response = await fetch(url, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(300000),
    body: JSON.stringify({
      model: aiConfig.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
      max_tokens: 4000,
    }),
  });

  if (!response.ok) {
    throw new Error(`AI API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty AI response');

  return parsePayslipAiResponse(content);
}
