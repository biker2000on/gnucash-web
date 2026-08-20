/**
 * Book-scoped document tags and deterministic auto-tag rules.
 *
 * Join table `gnucash_web_document_tags` mirrors `gnucash_web_transaction_tags`
 * (document_id + tag_id) and reuses the shared `gnucash_web_tags` vocabulary.
 * Persistence is raw SQL so this module does not depend on a regenerated
 * Prisma client.
 */

import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { isValidTagName, normalizeTagName, pickTagColor } from '@/lib/tags';
import {
  isDocumentTagMatchField,
  matchingTagNames,
  normalizeMatchValue,
  type DocumentTagMatchField,
  type DocumentTagRule,
  type DocumentTagRuleInput,
} from './tag-rules';

export class DocumentTagValidationError extends Error {}
export class DocumentTagNotFoundError extends Error {}

export interface DocumentTagVocabularyEntry {
  name: string;
  count: number;
}

export interface StoredDocumentTagRule {
  id: number;
  bookRootGuid: string;
  matchField: DocumentTagMatchField;
  matchValue: string;
  tag: string;
  createdAt: string;
}

export interface ApplyTagRulesResult {
  documentId: number;
  applied: number;
}

interface EntityDocRow {
  id: number;
  book_guid: string;
  title: string;
  file_name: string | null;
  issuer: string | null;
}

async function requireOwnedDocument(bookGuid: string, documentId: number): Promise<EntityDocRow> {
  const rows = await prisma.$queryRaw<EntityDocRow[]>`
    SELECT id, book_guid, title, file_name, issuer
    FROM gnucash_web_entity_documents
    WHERE id = ${documentId} AND book_guid = ${bookGuid}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new DocumentTagNotFoundError('Document not found');
  return row;
}

async function resolveOrCreateTagsForBook(
  bookGuid: string,
  rawNames: string[],
): Promise<Array<{ id: number; name: string }>> {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawNames) {
    const name = normalizeTagName(String(raw ?? ''));
    if (!isValidTagName(name)) {
      throw new DocumentTagValidationError(
        `Invalid tag name: "${raw}". Use lowercase letters, digits, hyphens, and underscores.`,
      );
    }
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  if (names.length === 0) return [];

  const existing = await prisma.gnucash_web_tags.findMany({
    where: { book_guid: bookGuid, name: { in: names } },
    select: { id: true, name: true },
  });
  const byName = new Map(existing.map((tag) => [tag.name, tag]));

  const missing = names.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    const used = await prisma.gnucash_web_tags.findMany({
      where: { book_guid: bookGuid },
      select: { color: true },
    });
    const usedColors = used.map((row) => row.color);
    for (const name of missing) {
      const color = pickTagColor(usedColors);
      usedColors.push(color);
      const created = await prisma.gnucash_web_tags.create({
        data: { book_guid: bookGuid, name, color },
        select: { id: true, name: true },
      });
      byName.set(name, created);
    }
  }

  return names.map((name) => byName.get(name)!);
}

export async function getDocumentTags(bookGuid: string, documentId: number): Promise<string[]> {
  await requireOwnedDocument(bookGuid, documentId);
  const rows = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT t.name
    FROM gnucash_web_document_tags dt
    JOIN gnucash_web_tags t ON t.id = dt.tag_id
    WHERE dt.document_id = ${documentId}
      AND t.book_guid = ${bookGuid}
    ORDER BY t.name ASC
  `;
  return rows.map((row) => row.name);
}

export async function getTagsForDocuments(
  bookGuid: string,
  documentIds: number[],
): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (documentIds.length === 0) return map;
  const rows = await prisma.$queryRaw<Array<{ document_id: number; name: string }>>`
    SELECT dt.document_id, t.name
    FROM gnucash_web_document_tags dt
    JOIN gnucash_web_tags t ON t.id = dt.tag_id
    JOIN gnucash_web_entity_documents e ON e.id = dt.document_id
    WHERE e.book_guid = ${bookGuid}
      AND t.book_guid = ${bookGuid}
      AND dt.document_id IN (${Prisma.join(documentIds)})
    ORDER BY t.name ASC
  `;
  for (const row of rows) {
    const list = map.get(row.document_id) ?? [];
    list.push(row.name);
    map.set(row.document_id, list);
  }
  return map;
}

export async function setDocumentTags(
  bookGuid: string,
  documentId: number,
  rawNames: string[],
): Promise<string[]> {
  await requireOwnedDocument(bookGuid, documentId);
  const tags = await resolveOrCreateTagsForBook(bookGuid, rawNames);

  await prisma.$executeRaw`
    DELETE FROM gnucash_web_document_tags
    WHERE document_id = ${documentId}
  `;
  for (const tag of tags) {
    await prisma.$executeRaw`
      INSERT INTO gnucash_web_document_tags (document_id, tag_id)
      VALUES (${documentId}, ${tag.id})
      ON CONFLICT DO NOTHING
    `;
  }
  return tags.map((tag) => tag.name);
}

export async function addDocumentTags(
  bookGuid: string,
  documentId: number,
  rawNames: string[],
): Promise<number> {
  await requireOwnedDocument(bookGuid, documentId);
  const tags = await resolveOrCreateTagsForBook(bookGuid, rawNames);
  if (tags.length === 0) return 0;

  const before = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n
    FROM gnucash_web_document_tags
    WHERE document_id = ${documentId}
  `;
  const beforeCount = Number(before[0]?.n ?? 0);

  for (const tag of tags) {
    await prisma.$executeRaw`
      INSERT INTO gnucash_web_document_tags (document_id, tag_id)
      VALUES (${documentId}, ${tag.id})
      ON CONFLICT DO NOTHING
    `;
  }

  const after = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n
    FROM gnucash_web_document_tags
    WHERE document_id = ${documentId}
  `;
  return Math.max(0, Number(after[0]?.n ?? 0) - beforeCount);
}

export async function deleteDocumentTags(bookGuid: string, documentId: number): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM gnucash_web_document_tags dt
    USING gnucash_web_entity_documents e
    WHERE dt.document_id = e.id
      AND e.id = ${documentId}
      AND e.book_guid = ${bookGuid}
  `;
}

export async function listDocumentTagVocabulary(
  bookGuid: string,
): Promise<DocumentTagVocabularyEntry[]> {
  const rows = await prisma.$queryRaw<Array<{ name: string; count: bigint }>>`
    SELECT t.name, COUNT(e.id)::bigint AS count
    FROM gnucash_web_tags t
    LEFT JOIN gnucash_web_document_tags dt ON dt.tag_id = t.id
    LEFT JOIN gnucash_web_entity_documents e
      ON e.id = dt.document_id AND e.book_guid = ${bookGuid}
    WHERE t.book_guid = ${bookGuid}
    GROUP BY t.id, t.name
    ORDER BY t.name ASC
  `;
  return rows.map((row) => ({ name: row.name, count: Number(row.count) }));
}

/* ------------------------------------------------------------------ */
/* Rules                                                                */
/* ------------------------------------------------------------------ */

interface RuleRow {
  id: number;
  book_root_guid: string;
  match_field: string;
  match_value: string;
  tag: string;
  created_at: Date;
}

function mapRule(row: RuleRow): StoredDocumentTagRule {
  return {
    id: row.id,
    bookRootGuid: row.book_root_guid,
    matchField: row.match_field as DocumentTagMatchField,
    matchValue: row.match_value,
    tag: row.tag,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at),
  };
}

export async function listDocumentTagRules(bookGuid: string): Promise<StoredDocumentTagRule[]> {
  const rows = await prisma.$queryRaw<RuleRow[]>`
    SELECT id, book_root_guid, match_field, match_value, tag, created_at
    FROM gnucash_web_document_tag_rules
    WHERE book_root_guid = ${bookGuid}
    ORDER BY id ASC
  `;
  return rows.map(mapRule);
}

export interface CreateDocumentTagRuleInput {
  matchField: unknown;
  matchValue: unknown;
  tag: unknown;
}

function parseRuleInput(input: CreateDocumentTagRuleInput): {
  matchField: DocumentTagMatchField;
  matchValue: string;
  tag: string;
} {
  if (!isDocumentTagMatchField(input.matchField)) {
    throw new DocumentTagValidationError(
      'match_field must be one of: filename, issuer, text',
    );
  }
  const matchValue = normalizeMatchValue(
    typeof input.matchValue === 'string' ? input.matchValue : '',
  );
  if (!matchValue) {
    throw new DocumentTagValidationError('match_value is required');
  }
  if (matchValue.length > 500) {
    throw new DocumentTagValidationError('match_value is too long (max 500)');
  }
  const tag = normalizeTagName(typeof input.tag === 'string' ? input.tag : '');
  if (!isValidTagName(tag)) {
    throw new DocumentTagValidationError(
      'tag must be lowercase letters, digits, hyphens, and underscores (max 100)',
    );
  }
  return { matchField: input.matchField, matchValue, tag };
}

export async function createDocumentTagRule(
  bookGuid: string,
  input: CreateDocumentTagRuleInput,
): Promise<StoredDocumentTagRule> {
  const parsed = parseRuleInput(input);
  const rows = await prisma.$queryRaw<RuleRow[]>`
    INSERT INTO gnucash_web_document_tag_rules
      (book_root_guid, match_field, match_value, tag)
    VALUES
      (${bookGuid}, ${parsed.matchField}, ${parsed.matchValue}, ${parsed.tag})
    RETURNING id, book_root_guid, match_field, match_value, tag, created_at
  `;
  return mapRule(rows[0]);
}

export async function updateDocumentTagRule(
  bookGuid: string,
  ruleId: number,
  input: CreateDocumentTagRuleInput,
): Promise<StoredDocumentTagRule> {
  const parsed = parseRuleInput(input);
  const rows = await prisma.$queryRaw<RuleRow[]>`
    UPDATE gnucash_web_document_tag_rules
    SET match_field = ${parsed.matchField},
        match_value = ${parsed.matchValue},
        tag = ${parsed.tag}
    WHERE id = ${ruleId} AND book_root_guid = ${bookGuid}
    RETURNING id, book_root_guid, match_field, match_value, tag, created_at
  `;
  if (!rows[0]) throw new DocumentTagNotFoundError('Rule not found');
  return mapRule(rows[0]);
}

export async function deleteDocumentTagRule(bookGuid: string, ruleId: number): Promise<void> {
  const result = await prisma.$executeRaw`
    DELETE FROM gnucash_web_document_tag_rules
    WHERE id = ${ruleId} AND book_root_guid = ${bookGuid}
  `;
  if (Number(result) === 0) throw new DocumentTagNotFoundError('Rule not found');
}

async function extractedTextForDocument(
  bookGuid: string,
  documentId: number,
): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ extracted_text: string | null }>>`
    SELECT extracted_text
    FROM gnucash_web_documents
    WHERE book_guid = ${bookGuid}
      AND source_kind = 'entity_document'
      AND source_id = ${String(documentId)}
    LIMIT 1
  `;
  return rows[0]?.extracted_text ?? null;
}

function ruleInputFromDoc(
  row: EntityDocRow,
  text: string | null,
): DocumentTagRuleInput {
  return {
    filename: row.file_name ?? row.title,
    issuer: row.issuer,
    text,
  };
}

export async function applyDocumentTagRulesForDocument(
  bookGuid: string,
  documentId: number,
  input?: DocumentTagRuleInput,
): Promise<number> {
  const row = await requireOwnedDocument(bookGuid, documentId);
  const rules = await listDocumentTagRules(bookGuid);
  if (rules.length === 0) return 0;
  const text = input?.text !== undefined
    ? input.text
    : await extractedTextForDocument(bookGuid, documentId);
  const names = matchingTagNames(rules as DocumentTagRule[], input ?? ruleInputFromDoc(row, text));
  if (names.length === 0) return 0;
  return addDocumentTags(bookGuid, documentId, names);
}

export async function applyDocumentTagRules(
  bookGuid: string,
): Promise<ApplyTagRulesResult[]> {
  const rules = await listDocumentTagRules(bookGuid);
  const docs = await prisma.$queryRaw<EntityDocRow[]>`
    SELECT id, book_guid, title, file_name, issuer
    FROM gnucash_web_entity_documents
    WHERE book_guid = ${bookGuid}
    ORDER BY id ASC
  `;
  if (docs.length === 0 || rules.length === 0) {
    return docs.map((doc) => ({ documentId: doc.id, applied: 0 }));
  }

  const texts = await prisma.$queryRaw<Array<{ source_id: string; extracted_text: string | null }>>`
    SELECT source_id, extracted_text
    FROM gnucash_web_documents
    WHERE book_guid = ${bookGuid}
      AND source_kind = 'entity_document'
  `;
  const textBySource = new Map(texts.map((row) => [row.source_id, row.extracted_text]));

  const results: ApplyTagRulesResult[] = [];
  for (const doc of docs) {
    const names = matchingTagNames(
      rules as DocumentTagRule[],
      ruleInputFromDoc(doc, textBySource.get(String(doc.id)) ?? null),
    );
    const applied = names.length > 0
      ? await addDocumentTags(bookGuid, doc.id, names)
      : 0;
    results.push({ documentId: doc.id, applied });
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Search enrichment                                                    */
/* ------------------------------------------------------------------ */

/**
 * Attach vault tags to canonical-document search hits and optionally keep
 * only hits that have every requested tag (AND). Non-entity hits have no
 * vault tags.
 */
export async function attachTagsToDocumentSearchHits<T extends { id: string }>(
  bookGuid: string,
  hits: T[],
  filterTags: string[] = [],
): Promise<Array<T & { tags: string[] }>> {
  const required = filterTags
    .map((name) => normalizeTagName(name))
    .filter((name) => isValidTagName(name));

  if (hits.length === 0) {
    return [];
  }

  const canonicalIds = hits
    .map((hit) => Number.parseInt(hit.id, 10))
    .filter((id) => Number.isInteger(id) && id > 0);

  const sources = canonicalIds.length === 0
    ? []
    : await prisma.$queryRaw<Array<{ id: number; source_id: string | null }>>`
        SELECT id, source_id
        FROM gnucash_web_documents
        WHERE book_guid = ${bookGuid}
          AND source_kind = 'entity_document'
          AND id IN (${Prisma.join(canonicalIds)})
      `;
  const entityIdByCanonical = new Map<number, number>();
  const entityIds: number[] = [];
  for (const row of sources) {
    const entityId = Number.parseInt(row.source_id ?? '', 10);
    if (!Number.isInteger(entityId) || entityId <= 0) continue;
    entityIdByCanonical.set(row.id, entityId);
    entityIds.push(entityId);
  }
  const tagMap = await getTagsForDocuments(bookGuid, entityIds);

  const tagged = hits.map((hit) => {
    const canonicalId = Number.parseInt(hit.id, 10);
    const entityId = entityIdByCanonical.get(canonicalId);
    const tags = entityId != null ? (tagMap.get(entityId) ?? []) : [];
    return { ...hit, tags };
  });

  if (required.length === 0) return tagged;
  return tagged.filter((hit) => required.every((name) => hit.tags.includes(name)));
}

export function parseTagsQueryParam(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => normalizeTagName(part))
    .filter((name) => isValidTagName(name));
}
