/**
 * AI-based statement extraction (for PDF statements).
 *
 * Mirrors src/lib/payslip-extract-core.ts / payslip-extraction.ts: builds a
 * prompt, POSTs to an OpenAI-compatible /chat/completions endpoint, and
 * robustly parses the JSON reply.
 *
 * AMOUNT SIGN CONVENTION (shared): positive = money INTO the account
 * (deposit / credit), negative = money OUT (withdrawal / debit).
 */

import type { AiConfig } from '@/lib/receipt-extraction';
import type { ParsedStatement, ParsedStatementLine } from './csv-ofx';
import { parseStatementDate, parseStatementAmount } from './csv-ofx';

export interface StatementAiExtractOptions {
  aiConfig: AiConfig | null;
}

const SYSTEM_PROMPT = `You are a bank/credit-card statement data extraction assistant. Extract structured data from statement text and return ONLY valid JSON with no explanation and no markdown.

The JSON must have these fields:
- startDate (string, optional): statement period start, YYYY-MM-DD
- endDate (string, optional): statement period end, YYYY-MM-DD
- openingBalance (number, optional): opening/previous balance
- closingBalance (number, optional): closing/new balance
- currency (string, optional): ISO currency code, e.g. "USD"
- lines (array): one object per transaction, each with:
  - date (string): transaction date, YYYY-MM-DD
  - description (string): merchant / payee / memo text
  - amount (number): SIGNED amount. POSITIVE = money INTO the account (deposit, credit, payment received). NEGATIVE = money OUT of the account (purchase, withdrawal, debit, fee).

Rules:
- Include every transaction line you can identify.
- Do NOT include running-balance-only rows or summary/subtotal rows as transactions.
- Amounts must use the sign convention above regardless of how the statement displays them.
- Return ONLY valid JSON. No markdown fences, no commentary.`;

/** Strip markdown fences and parse the AI reply into a validated ParsedStatement. */
export function parseStatementAiResponse(raw: string): ParsedStatement {
  let jsonStr = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  // If the model wrapped JSON in prose, grab the outermost {...}.
  if (!jsonStr.startsWith('{')) {
    const first = jsonStr.indexOf('{');
    const last = jsonStr.lastIndexOf('}');
    if (first !== -1 && last > first) jsonStr = jsonStr.slice(first, last + 1);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Failed to parse AI response as JSON: ${raw.slice(0, 120)}`);
  }

  const rawLines = Array.isArray(parsed.lines) ? parsed.lines : [];
  const lines: ParsedStatementLine[] = [];
  for (const item of rawLines) {
    if (!item || typeof item !== 'object') continue;
    const i = item as Record<string, unknown>;
    const date = typeof i.date === 'string' ? parseStatementDate(i.date) : null;
    let amount: number | null = null;
    if (typeof i.amount === 'number' && Number.isFinite(i.amount)) amount = i.amount;
    else if (typeof i.amount === 'string') amount = parseStatementAmount(i.amount);
    if (!date || amount === null) continue;
    lines.push({
      date,
      description: typeof i.description === 'string' ? i.description.trim() : '',
      amount,
    });
  }

  const result: ParsedStatement = { lines };

  const startDate = typeof parsed.startDate === 'string' ? parseStatementDate(parsed.startDate) : null;
  const endDate = typeof parsed.endDate === 'string' ? parseStatementDate(parsed.endDate) : null;
  if (startDate) result.startDate = startDate;
  if (endDate) result.endDate = endDate;

  if (typeof parsed.openingBalance === 'number') result.openingBalance = parsed.openingBalance;
  else if (typeof parsed.openingBalance === 'string') {
    const v = parseStatementAmount(parsed.openingBalance);
    if (v !== null) result.openingBalance = v;
  }
  if (typeof parsed.closingBalance === 'number') result.closingBalance = parsed.closingBalance;
  else if (typeof parsed.closingBalance === 'string') {
    const v = parseStatementAmount(parsed.closingBalance);
    if (v !== null) result.closingBalance = v;
  }
  if (typeof parsed.currency === 'string' && parsed.currency.trim()) {
    result.currency = parsed.currency.trim().toUpperCase();
  }

  return result;
}

/**
 * Extract a statement from plain text (e.g. text pulled out of a PDF) using AI.
 * Throws a clear error if aiConfig is disabled or incomplete.
 */
export async function extractStatementFromText(
  text: string,
  { aiConfig }: StatementAiExtractOptions,
): Promise<ParsedStatement> {
  if (!aiConfig || !aiConfig.enabled || !aiConfig.base_url || !aiConfig.model) {
    throw new Error(
      'AI is not configured. Enable AI extraction (base URL + model) to parse PDF statements.',
    );
  }
  if (!text || !text.trim()) {
    throw new Error('No text could be extracted from the PDF for AI parsing.');
  }

  const url = `${aiConfig.base_url.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (aiConfig.api_key) headers['Authorization'] = `Bearer ${aiConfig.api_key}`;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(300000),
    body: JSON.stringify({
      model: aiConfig.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      temperature: 0,
      max_tokens: 8000,
    }),
  });

  if (!response.ok) {
    throw new Error(`AI API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty AI response');

  return parseStatementAiResponse(content);
}
