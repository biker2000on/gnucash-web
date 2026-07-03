/**
 * AI-assisted IRS contribution limit lookup.
 *
 * GET  -> { configured: boolean }  (whether an AI provider is available)
 * POST -> { year } -> preview payload { year, current, fetched }
 *
 * IMPORTANT: this route NEVER writes to the database. The client shows the
 * fetched values as a diff against current values and only persists them
 * via PUT /api/contribution-limits after explicit user confirmation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getAiConfig } from '@/lib/ai-config';
import { getAllLimitsForYear } from '@/lib/reports/irs-limits';
import { getExpectedLimitTypes } from '@/lib/services/limit-coverage.service';
import type { AiConfig } from '@/lib/receipt-extraction';

export interface AiFetchedLimit {
  account_type: string;
  base: number | null;
  catchUp: number | null;
  catchUpAge: number | null;
  source: string | null;
}

function isAiConfigured(config: AiConfig | null): config is AiConfig {
  return !!config && config.enabled && !!config.base_url && !!config.model;
}

export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user } = roleResult;

    const config = await getAiConfig(user.id);
    return NextResponse.json({ configured: isAiConfigured(config) });
  } catch (error) {
    console.error('AI limit-fetch config check error:', error);
    return NextResponse.json({ configured: false });
  }
}

function buildPrompt(year: number, accountTypes: string[]): { system: string; user: string } {
  return {
    system:
      'You are a careful assistant for US tax reference data. You respond with strict JSON only — ' +
      'no markdown fences, no commentary. Accuracy matters more than completeness: when you are not ' +
      'certain of a published value, return null rather than guessing or extrapolating.',
    user:
      `Return the official IRS contribution limits for tax year ${year} for these account types: ` +
      `${accountTypes.join(', ')}.\n\n` +
      'Respond with a JSON array. Each element must have exactly these fields:\n' +
      '{"account_type": string, "base": number|null, "catchUp": number|null, "catchUpAge": number|null, "source": string|null}\n\n' +
      'Definitions:\n' +
      '- "base": the annual base contribution limit in USD (for 401k/403b/457 the employee elective deferral limit; ' +
      'for sep_ira the IRC 415(c) employer/self-employed cap; for hsa the self-only coverage limit; ' +
      'for fsa the health FSA salary-reduction limit; coverdell_esa is fixed at 2000).\n' +
      '- "catchUp": the standard age-based catch-up contribution amount (0 if the account type has none).\n' +
      '- "catchUpAge": the age at which catch-up eligibility begins (50 for retirement accounts, 55 for HSA).\n' +
      '- "source": the IRS Revenue Procedure or Notice that published the number, e.g. "Notice 2024-80" or ' +
      '"Rev. Proc. 2024-25" (HSA limits come from a Rev. Proc. released the prior spring). Cite the actual ' +
      'document for this year; if you cannot, set source to null.\n\n' +
      `If the IRS has not yet published limits for ${year}, or you do not know a value with confidence, ` +
      'return null for that value. NEVER invent or extrapolate numbers.',
  };
}

function parseAiLimits(content: string, validTypes: Set<string>): AiFetchedLimit[] {
  const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error('AI response was not valid JSON');
  }

  const arr = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { limits?: unknown }).limits))
      ? (parsed as { limits: unknown[] }).limits
      : null;
  if (!arr) throw new Error('AI response was not a JSON array');

  const asNumberOrNull = (v: unknown): number | null =>
    typeof v === 'number' && isFinite(v) && v >= 0 ? v : null;

  const results: AiFetchedLimit[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const accountType = typeof row.account_type === 'string' ? row.account_type : null;
    if (!accountType || !validTypes.has(accountType)) continue;
    results.push({
      account_type: accountType,
      base: asNumberOrNull(row.base),
      catchUp: asNumberOrNull(row.catchUp),
      catchUpAge: asNumberOrNull(row.catchUpAge),
      source: typeof row.source === 'string' && row.source.trim() ? row.source.trim() : null,
    });
  }
  return results;
}

export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user } = roleResult;

    const config = await getAiConfig(user.id);
    if (!isAiConfigured(config)) {
      return NextResponse.json({ error: 'AI is not configured. Set up a provider under Settings → AI first.' }, { status: 400 });
    }

    const body = await request.json();
    const year = Number(body?.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return NextResponse.json({ error: 'year must be an integer between 2000 and 2100' }, { status: 400 });
    }

    const accountTypes = getExpectedLimitTypes();
    const { system, user: userPrompt } = buildPrompt(year, accountTypes);

    // Same OpenAI-compatible chat/completions pattern as payslip/receipt extraction
    const url = `${config.base_url!.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.api_key) headers['Authorization'] = `Bearer ${config.api_key}`;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      return NextResponse.json({ error: `AI API error: ${response.status}` }, { status: 502 });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return NextResponse.json({ error: 'Empty AI response' }, { status: 502 });
    }

    let fetched: AiFetchedLimit[];
    try {
      fetched = parseAiLimits(content, new Set(accountTypes));
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to parse AI response' }, { status: 502 });
    }

    const current = await getAllLimitsForYear(year);
    return NextResponse.json({ year, current, fetched, model: config.model });
  } catch (error) {
    console.error('AI limit fetch error:', error);
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? 'AI request timed out'
      : 'Failed to fetch limits with AI';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
