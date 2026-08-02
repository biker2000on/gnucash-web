// src/lib/resilience/insurance-parse.ts

/**
 * AI insurance-policy document parsing.
 *
 * Follows the app's existing extraction plumbing: the OpenAI-compatible
 * `{base_url}/chat/completions` vision pattern used by payslip extraction
 * (see `extractPayslipWithVision` in '@/lib/payslip-extraction'), with the
 * per-user AiConfig resolved by getAiConfig() in '@/lib/ai-config'.
 *
 * The model only ever receives a single document image and is asked for the
 * LAST FOUR characters of the policy number — raw policy numbers are never
 * stored or returned (same masking rule as the claims-package export).
 *
 * The result is a *suggestion* returned to the client for review; nothing is
 * written server-side.
 */

import type { AiConfig } from '@/lib/receipt-extraction';
import { extractJsonObject } from '@/lib/ai-query/client';
import { renderPdfToBase64 } from '@/lib/payslip-extraction';
import type { InsurancePolicyType } from './types';

export interface InsurancePolicySuggestion {
  provider: string | null;
  policyType: InsurancePolicyType | null;
  coveredEntity: string | null;
  coverageLimit: number | null;
  deductible: number | null;
  annualPremium: number | null;
  /** YYYY-MM-DD or null. */
  renewalDate: string | null;
  /** Masked to the last 4 characters, e.g. "…4821". Never the full number. */
  policyNumberMasked: string | null;
  sublimits: Array<{ category: string; limit: number }>;
}

const POLICY_TYPES: InsurancePolicyType[] = ['home', 'renters', 'auto', 'umbrella', 'life', 'health', 'other'];

/** Vision prompt asking for structured policy fields as strict JSON. */
export function buildInsuranceParsePrompt(): string {
  return `Extract structured data from this insurance policy document (declarations page, certificate, or renewal notice). Return ONLY valid JSON with these fields:

- provider (string or null): insurance company name
- policy_type (string or null): one of "home", "renters", "auto", "umbrella", "life", "health", "other"
- covered_entity (string or null): what or who is covered (property address, vehicle, person)
- coverage_limit (number or null): primary coverage limit / dwelling limit / death benefit in dollars
- deductible (number or null): deductible in dollars
- annual_premium (number or null): annual premium in dollars (multiply monthly premiums by 12)
- renewal_date (string or null): policy renewal or expiration date in YYYY-MM-DD format
- policy_number_last4 (string or null): ONLY the last 4 characters of the policy number. NEVER return the full policy number.
- sublimits (array): category sub-limits, each { "category": string, "limit": number } — e.g. jewelry, electronics, personal property, liability

Rules: numbers must be plain numbers with no currency symbols or commas. Use null for anything not present in the document. Return ONLY valid JSON, no markdown, no explanation.`;
}

function cleanString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function cleanMoney(value: unknown): number | null {
  const num = typeof value === 'string' ? Number(value.replace(/[$,]/g, '')) : value;
  if (typeof num !== 'number' || !Number.isFinite(num) || num < 0 || num > 1_000_000_000) return null;
  return Math.round(num * 100) / 100;
}

/**
 * Parse and sanitize a model reply into an InsurancePolicySuggestion.
 * Defensive against a model that ignores instructions: the policy number is
 * re-masked here to its last 4 characters no matter what came back.
 */
export function parseInsuranceAiResponse(raw: string): InsurancePolicySuggestion {
  const parsed = extractJsonObject(raw);

  const rawType = typeof parsed.policy_type === 'string' ? parsed.policy_type.trim().toLowerCase() : null;
  const policyType = rawType && (POLICY_TYPES as string[]).includes(rawType)
    ? rawType as InsurancePolicyType
    : rawType ? 'other' as const : null;

  const rawRenewal = typeof parsed.renewal_date === 'string' ? parsed.renewal_date.trim() : null;
  const renewalDate = rawRenewal && /^\d{4}-\d{2}-\d{2}$/.test(rawRenewal) ? rawRenewal : null;

  // Enforce masking server-side regardless of what the model returned.
  const rawNumber = typeof parsed.policy_number_last4 === 'string' ? parsed.policy_number_last4.trim() : '';
  const last4 = rawNumber.replace(/[^A-Za-z0-9]/g, '').slice(-4);
  const policyNumberMasked = last4 ? `…${last4}` : null;

  const rawSublimits = Array.isArray(parsed.sublimits) ? parsed.sublimits : [];
  const sublimits = rawSublimits
    .flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return [];
      const entry = item as Record<string, unknown>;
      const category = cleanString(entry.category, 120);
      const limit = cleanMoney(entry.limit);
      return category && limit !== null ? [{ category, limit }] : [];
    })
    .slice(0, 50);

  return {
    provider: cleanString(parsed.provider, 160),
    policyType,
    coveredEntity: cleanString(parsed.covered_entity, 160),
    coverageLimit: cleanMoney(parsed.coverage_limit),
    deductible: cleanMoney(parsed.deductible),
    annualPremium: cleanMoney(parsed.annual_premium),
    renewalDate,
    policyNumberMasked,
    sublimits,
  };
}

/**
 * Extract policy data from a single vault document (PDF, JPEG, or PNG) using
 * the configured vision-capable model. PDFs are rendered to a PNG first via
 * the shared pdftoppm helper.
 */
export async function extractInsurancePolicyDocument(input: {
  buffer: Buffer;
  mimeType: string;
  aiConfig: AiConfig;
}): Promise<InsurancePolicySuggestion> {
  const { buffer, mimeType, aiConfig } = input;
  if (!aiConfig.enabled || !aiConfig.base_url || !aiConfig.model) {
    throw new Error('AI config is not enabled or missing base_url/model');
  }

  let base64: string;
  let mediaType: string;
  if (mimeType.includes('pdf')) {
    const rendered = await renderPdfToBase64(buffer);
    if (!rendered) throw new Error('Failed to render the PDF for AI parsing');
    base64 = rendered;
    mediaType = 'image/png';
  } else {
    base64 = buffer.toString('base64');
    mediaType = mimeType;
  }

  const url = `${aiConfig.base_url.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (aiConfig.api_key) headers['Authorization'] = `Bearer ${aiConfig.api_key}`;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model: aiConfig.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: buildInsuranceParsePrompt() },
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
        ],
      }],
      temperature: 0,
      max_tokens: 2000,
    }),
  });

  if (!response.ok) throw new Error(`AI API error: ${response.status}`);

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') throw new Error('Empty AI response');

  return parseInsuranceAiResponse(content);
}
