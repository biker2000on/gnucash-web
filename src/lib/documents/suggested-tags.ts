/**
 * Advisory tag suggestions derived from extraction results.
 *
 * These never write tags on their own — accepting a suggestion goes through
 * the ordinary document-tag PUT. Rule-based tags are a separate, deterministic
 * write path.
 */

import { isValidTagName, normalizeTagName } from '@/lib/tags';

const MAX_SUGGESTED_TAGS = 12;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function pushTag(into: string[], seen: Set<string>, raw: unknown): void {
  if (typeof raw !== 'string') return;
  const name = normalizeTagName(raw);
  if (!isValidTagName(name) || seen.has(name)) return;
  seen.add(name);
  into.push(name);
}

/**
 * Collect advisory tag names from a stored suggestion payload plus the
 * document's primary category. Order is stable: explicit AI tags, then
 * specialised fields, then doc type.
 */
export function deriveSuggestedTags(input: {
  suggestionKind?: string | null;
  suggestions?: unknown;
  docType?: string | null;
}): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  const suggestions = asRecord(input.suggestions);

  if (suggestions) {
    const explicit = suggestions.tags ?? suggestions.suggestedTags;
    if (Array.isArray(explicit)) {
      for (const item of explicit) pushTag(tags, seen, item);
    }
    pushTag(tags, seen, suggestions.taxForm ?? suggestions.tax_form);
    pushTag(tags, seen, suggestions.issuer);
    pushTag(tags, seen, suggestions.documentClass ?? suggestions.document_class);
    pushTag(tags, seen, suggestions.provider);
    const parties = suggestions.parties;
    if (Array.isArray(parties) && parties[0]) pushTag(tags, seen, parties[0]);
  }

  pushTag(tags, seen, input.docType);

  return tags.slice(0, MAX_SUGGESTED_TAGS);
}

/** Merge derived tags onto a suggestions object without dropping existing keys. */
export function withSuggestedTags<T>(
  suggestions: T,
  extra: { suggestionKind?: string | null; docType?: string | null },
): T & { suggestedTags: string[] } {
  const base = (suggestions && typeof suggestions === 'object')
    ? suggestions as Record<string, unknown>
    : {};
  const suggestedTags = deriveSuggestedTags({
    suggestionKind: extra.suggestionKind,
    suggestions,
    docType: extra.docType,
  });
  return { ...base, suggestedTags } as T & { suggestedTags: string[] };
}
