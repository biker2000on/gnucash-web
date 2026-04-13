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

/** Extract payslip data from OCR text using AI. */
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
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      model: aiConfig.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
      max_tokens: 1500,
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
