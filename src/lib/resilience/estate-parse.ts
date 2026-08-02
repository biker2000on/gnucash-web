// src/lib/resilience/estate-parse.ts

/**
 * AI estate-document parsing.
 *
 * Mirrors the insurance-policy parser (see './insurance-parse'): the same
 * OpenAI-compatible `{base_url}/chat/completions` vision pattern used by payslip
 * extraction, with the per-user AiConfig resolved by getAiConfig().
 *
 * Only the single selected vault document is sent to the model. Raw document
 * text is never persisted — the result is a *suggestion* returned to the client,
 * which prefills the estate-document form for the user to review and save.
 */

import type { AiConfig } from '@/lib/receipt-extraction';
import { extractJsonObject } from '@/lib/ai-query/client';
import { renderPdfToBase64 } from '@/lib/payslip-extraction';
import type { EstateDocumentKind, EstateMemberRole } from './types';

export interface EstateDocumentSuggestion {
  kind: EstateDocumentKind | null;
  /** Testator / principal / declarant the document belongs to. */
  principalName: string | null;
  /** Execution or signing date, YYYY-MM-DD or null. Maps to lastUpdatedDate. */
  executionDate: string | null;
  /** Two-letter state code the document was executed under, or null. */
  state: string | null;
  /** Attorney-in-fact, healthcare agent, or executor names. */
  agentNames: string[];
  /** True/false when the document clearly shows a notary block; null otherwise. */
  notarized: boolean | null;
  /**
   * Household role matched from principalName against the roster, or null when
   * no confident match was made. Filled in by matchEstateMemberRole() on the
   * server so the form can prefill the right person.
   */
  memberRole: EstateMemberRole | null;
  /** The roster name that matched, echoed back for the display snapshot. */
  memberName: string | null;
}

const DOCUMENT_KINDS: EstateDocumentKind[] = [
  'will',
  'revocable_trust',
  'financial_poa',
  'healthcare_poa',
  'healthcare_directive',
  'guardianship_letter',
  'beneficiary_letter',
  'other',
];

/**
 * Title fragments that identify a document kind when the model returns free
 * text instead of an enum value. Order matters: the most specific phrases win,
 * so "health care power of attorney" is not swallowed by "power of attorney"
 * and a North Carolina "Advance Directive for a Natural Death" (the state's
 * living will, often filed as "ND and Treatment Instructions") resolves to
 * healthcare_directive rather than healthcare_poa.
 */
const KIND_PATTERNS: Array<{ kind: EstateDocumentKind; patterns: RegExp[] }> = [
  {
    kind: 'healthcare_directive',
    patterns: [
      /advance\s+directive/,
      /natural\s+death/,
      /\bnd\s+and\s+treatment\s+instructions?\b/,
      /treatment\s+instructions?/,
      /living\s+will/,
      /declaration\s+of\s+a\s+desire/,
      /life[-\s]?prolonging/,
      /\bdnr\b|do\s+not\s+resuscitate/,
    ],
  },
  {
    kind: 'healthcare_poa',
    patterns: [
      /health\s*care\s+power\s+of\s+attorney/,
      // Vault titles are often abbreviated ("Cara Healthcare POA").
      /health\s*care\s+poa\b/,
      /medical\s+power\s+of\s+attorney/,
      /medical\s+poa\b/,
      /health\s*care\s+proxy/,
      /health\s*care\s+agent/,
      /\bhcpoa\b/,
    ],
  },
  {
    kind: 'financial_poa',
    patterns: [
      /durable\s+power\s+of\s+attorney/,
      /financial\s+power\s+of\s+attorney/,
      /general\s+power\s+of\s+attorney/,
      /power\s+of\s+attorney/,
      /attorney[-\s]in[-\s]fact/,
      /\bpoa\b/,
    ],
  },
  {
    kind: 'will',
    patterns: [/last\s+will/, /last\s+will\s+and\s+testament/, /\btestament\b/, /codicil/, /\bwill\b/],
  },
  {
    kind: 'revocable_trust',
    patterns: [/revocable\s+(living\s+)?trust/, /living\s+trust/, /trust\s+agreement/, /\btrust\b/],
  },
  { kind: 'guardianship_letter', patterns: [/guardian/, /nomination\s+of\s+guardian/] },
  { kind: 'beneficiary_letter', patterns: [/letter\s+of\s+instruction/, /beneficiary\s+letter/] },
];

/** Vision prompt asking for structured estate-document fields as strict JSON. */
export function buildEstateParsePrompt(): string {
  return `Extract structured data from this estate planning document (will, trust, power of attorney, advance directive, or similar). Return ONLY valid JSON with these fields:

- kind (string or null): one of "will", "revocable_trust", "financial_poa", "healthcare_poa", "healthcare_directive", "guardianship_letter", "beneficiary_letter", "other". Classify by the document's own title: a "Last Will and Testament" is "will"; a "Durable Power of Attorney" or "General/Financial Power of Attorney" is "financial_poa"; a "Health Care Power of Attorney" or "Medical Power of Attorney" is "healthcare_poa"; a living will, "Advance Directive for a Natural Death", "Declaration of a Desire for a Natural Death", or "ND and Treatment Instructions" is "healthcare_directive"; a revocable or living trust is "revocable_trust".
- document_title (string or null): the document's printed title, verbatim
- principal_name (string or null): the person the document belongs to — the testator, principal, declarant, grantor, or settlor. NOT the agent, attorney-in-fact, or witness.
- execution_date (string or null): the date the document was signed or executed, in YYYY-MM-DD format
- state (string or null): the two-letter US state code the document was executed under (e.g. "NC")
- agent_names (array of strings): the named attorney(s)-in-fact, health care agent(s), executor(s), or successor trustee(s)
- notarized (true, false, or null): true if a notary acknowledgment or seal is present, false if clearly absent, null if undeterminable

Rules: use null for anything not present in the document. Return ONLY valid JSON, no markdown, no explanation.`;
}

function cleanString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

/** Resolve a free-text title or enum value to an EstateDocumentKind. */
export function classifyEstateDocumentKind(value: string | null | undefined): EstateDocumentKind | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return null;
  const normalized = raw.replace(/[_\s]+/g, ' ').trim();
  const asEnum = raw.replace(/[\s-]+/g, '_');
  if ((DOCUMENT_KINDS as string[]).includes(asEnum)) return asEnum as EstateDocumentKind;
  for (const entry of KIND_PATTERNS) {
    if (entry.patterns.some(pattern => pattern.test(normalized))) return entry.kind;
  }
  return null;
}

/**
 * Parse and sanitize a model reply into an EstateDocumentSuggestion.
 * Pure and defensive: an unrecognized `kind` falls back to the document title,
 * then to 'other'; dates must be strict YYYY-MM-DD; memberRole is always null
 * here and filled in server-side by matchEstateMemberRole().
 */
export function parseEstateAiResponse(raw: string): EstateDocumentSuggestion {
  const parsed = extractJsonObject(raw);

  const title = cleanString(parsed.document_title, 200);
  const kindFromField = classifyEstateDocumentKind(
    typeof parsed.kind === 'string' ? parsed.kind : null,
  );
  const kindFromTitle = classifyEstateDocumentKind(title);
  // A recognizable title beats a bare "other" from the model.
  const kind = kindFromField && kindFromField !== 'other'
    ? kindFromField
    : kindFromTitle ?? kindFromField ?? null;

  const rawDate = typeof parsed.execution_date === 'string' ? parsed.execution_date.trim() : null;
  const executionDate = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;

  const rawState = typeof parsed.state === 'string' ? parsed.state.trim().toUpperCase() : null;
  const state = rawState && /^[A-Z]{2}$/.test(rawState) ? rawState : null;

  const rawAgents = Array.isArray(parsed.agent_names) ? parsed.agent_names : [];
  const agentNames = rawAgents
    .flatMap((item: unknown) => {
      const name = cleanString(item, 160);
      return name ? [name] : [];
    })
    .slice(0, 20);

  return {
    kind,
    principalName: cleanString(parsed.principal_name, 200),
    executionDate,
    state,
    agentNames,
    notarized: typeof parsed.notarized === 'boolean' ? parsed.notarized : null,
    memberRole: null,
    memberName: null,
  };
}

/** Normalize a person's name for comparison: lowercase, single-spaced, no punctuation. */
function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[.,'’]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Match an extracted principal name against the household roster.
 *
 * Matches on the full name first, then on a unique first name — "Cara" resolves
 * to "Cara Crawford" only when no other roster member shares that first name.
 * Returns null when there is no confident match so the user picks the person.
 */
export function matchEstateMemberRole(
  principalName: string | null,
  roster: Array<{ role: string; name: string }>,
): { memberRole: EstateMemberRole; memberName: string } | null {
  const target = principalName ? normalizeName(principalName) : '';
  if (!target) return null;
  const candidates = roster
    .filter(member => member.name.trim() && ['self', 'spouse', 'dependent'].includes(member.role))
    .map(member => ({
      role: member.role as EstateMemberRole,
      name: member.name.trim(),
      normalized: normalizeName(member.name),
    }));

  const exact = candidates.filter(member => member.normalized === target);
  if (exact.length === 1) return { memberRole: exact[0].role, memberName: exact[0].name };

  const targetFirst = target.split(' ')[0];
  const byFirstName = candidates.filter(member => member.normalized.split(' ')[0] === targetFirst);
  if (byFirstName.length === 1) return { memberRole: byFirstName[0].role, memberName: byFirstName[0].name };

  return null;
}

/**
 * Extract estate-document data from a single vault document (PDF, JPEG, or PNG)
 * using the configured vision-capable model. PDFs are rendered to a PNG first
 * via the shared pdftoppm helper.
 */
export async function extractEstateDocument(input: {
  buffer: Buffer;
  mimeType: string;
  aiConfig: AiConfig;
}): Promise<EstateDocumentSuggestion> {
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
          { type: 'text', text: buildEstateParsePrompt() },
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

  return parseEstateAiResponse(content);
}
