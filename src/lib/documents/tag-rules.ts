/**
 * Deterministic document auto-tag matching.
 *
 * A rule fires when `matchValue` occurs as a case-insensitive substring of the
 * selected field (filename, issuer, or extracted text). Matching is a pure
 * function: no I/O, no SQL LIKE metacharacters, empty needles never match.
 */

import { isValidTagName, normalizeTagName } from '@/lib/tags';

export const DOCUMENT_TAG_MATCH_FIELDS = ['filename', 'issuer', 'text'] as const;
export type DocumentTagMatchField = (typeof DOCUMENT_TAG_MATCH_FIELDS)[number];

export interface DocumentTagRule {
  id?: number;
  matchField: DocumentTagMatchField;
  matchValue: string;
  tag: string;
}

export interface DocumentTagRuleInput {
  filename?: string | null;
  issuer?: string | null;
  text?: string | null;
}

export function isDocumentTagMatchField(value: unknown): value is DocumentTagMatchField {
  return typeof value === 'string'
    && (DOCUMENT_TAG_MATCH_FIELDS as readonly string[]).includes(value);
}

/** Trimmed needle used for matching; empty after trim means "never matches". */
export function normalizeMatchValue(raw: string | null | undefined): string {
  return (raw ?? '').trim();
}

function fieldValue(rule: DocumentTagRule, input: DocumentTagRuleInput): string | null {
  switch (rule.matchField) {
    case 'filename':
      return input.filename ?? null;
    case 'issuer':
      return input.issuer ?? null;
    case 'text':
      return input.text ?? null;
    default:
      return null;
  }
}

/**
 * True when `matchValue` is a non-empty case-insensitive substring of the
 * chosen field. `%` / `_` are literal characters, not LIKE wildcards.
 */
export function ruleMatches(rule: DocumentTagRule, input: DocumentTagRuleInput): boolean {
  const needle = normalizeMatchValue(rule.matchValue);
  if (!needle) return false;
  if (!isDocumentTagMatchField(rule.matchField)) return false;
  const haystack = fieldValue(rule, input);
  if (haystack == null || haystack === '') return false;
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

/**
 * Rules that fire for this document, in input order. Duplicate tag names
 * (after normalize) collapse to the first firing rule.
 */
export function matchingRules(
  rules: readonly DocumentTagRule[],
  input: DocumentTagRuleInput,
): DocumentTagRule[] {
  const seen = new Set<string>();
  const matched: DocumentTagRule[] = [];
  for (const rule of rules) {
    if (!ruleMatches(rule, input)) continue;
    const tag = normalizeTagName(rule.tag);
    if (!isValidTagName(tag) || seen.has(tag)) continue;
    seen.add(tag);
    matched.push({ ...rule, tag });
  }
  return matched;
}

export function matchingTagNames(
  rules: readonly DocumentTagRule[],
  input: DocumentTagRuleInput,
): string[] {
  return matchingRules(rules, input).map((rule) => rule.tag);
}
