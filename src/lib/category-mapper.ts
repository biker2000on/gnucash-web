// src/lib/category-mapper.ts

import { distance } from 'fastest-levenshtein';
import prisma from '@/lib/prisma';

/**
 * Normalize item name: lowercase, trim whitespace
 */
export function normalizeKeyword(itemName: string): string {
  return itemName.toLowerCase().trim();
}

/**
 * Find best account suggestion for an item.
 * Returns null if no match found.
 */
export async function suggestAccount(
  bookGuid: string,
  itemName: string,
  source: string = 'amazon'
): Promise<{ accountGuid: string; confidence: number; keyword: string } | null> {
  const normalized = normalizeKeyword(itemName);

  const mappings = await prisma.$queryRaw<
    Array<{
      keyword: string;
      keyword_normalized: string;
      account_guid: string;
      use_count: number;
    }>
  >`SELECT keyword, keyword_normalized, account_guid, use_count
    FROM gnucash_web_category_mappings
    WHERE book_guid = ${bookGuid} AND source = ${source}`;

  let bestScore = 0;
  let bestMatch: { accountGuid: string; confidence: number; keyword: string } | null = null;

  for (const mapping of mappings) {
    let confidence = 0;

    if (normalized === mapping.keyword_normalized) {
      confidence = 1.0;
    } else if (normalized.includes(mapping.keyword_normalized)) {
      confidence = 0.7;
    } else if (mapping.keyword_normalized.includes(normalized)) {
      confidence = 0.6;
    } else if (distance(normalized, mapping.keyword_normalized) < 3) {
      confidence = 0.4;
    } else {
      continue;
    }

    // Weight by use_count: caps at 5 uses
    const useWeight = Math.min(1, mapping.use_count / 5);
    const score = confidence * useWeight;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = {
        accountGuid: mapping.account_guid,
        confidence: score,
        keyword: mapping.keyword,
      };
    }
  }

  return bestMatch;
}

/**
 * Record a user's mapping choice (upsert: insert or increment use_count)
 */
export async function recordMapping(
  bookGuid: string,
  itemName: string,
  accountGuid: string,
  source: string = 'amazon'
): Promise<void> {
  const keyword = itemName;
  const keywordNormalized = normalizeKeyword(itemName);

  await prisma.$executeRaw`
    INSERT INTO gnucash_web_category_mappings (book_guid, source, keyword, keyword_normalized, account_guid, use_count, last_used_at, created_at)
    VALUES (${bookGuid}, ${source}, ${keyword}, ${keywordNormalized}, ${accountGuid}, 1, NOW(), NOW())
    ON CONFLICT (book_guid, source, keyword_normalized)
    DO UPDATE SET use_count = gnucash_web_category_mappings.use_count + 1,
      last_used_at = NOW(),
      account_guid = ${accountGuid}
  `;
}

/**
 * Get all mappings for a book (for the management UI)
 */
export async function listMappings(
  bookGuid: string,
  source?: string
): Promise<
  Array<{
    id: number;
    keyword: string;
    keywordNormalized: string;
    accountGuid: string;
    useCount: number;
    lastUsedAt: Date;
  }>
> {
  const rows = source
    ? await prisma.$queryRaw<
        Array<{
          id: number;
          keyword: string;
          keyword_normalized: string;
          account_guid: string;
          use_count: number;
          last_used_at: Date;
        }>
      >`SELECT id, keyword, keyword_normalized, account_guid, use_count, last_used_at
        FROM gnucash_web_category_mappings
        WHERE book_guid = ${bookGuid} AND source = ${source}
        ORDER BY last_used_at DESC`
    : await prisma.$queryRaw<
        Array<{
          id: number;
          keyword: string;
          keyword_normalized: string;
          account_guid: string;
          use_count: number;
          last_used_at: Date;
        }>
      >`SELECT id, keyword, keyword_normalized, account_guid, use_count, last_used_at
        FROM gnucash_web_category_mappings
        WHERE book_guid = ${bookGuid}
        ORDER BY last_used_at DESC`;

  return rows.map((row) => ({
    id: row.id,
    keyword: row.keyword,
    keywordNormalized: row.keyword_normalized,
    accountGuid: row.account_guid,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
  }));
}

/**
 * Delete a mapping
 */
export async function deleteMapping(id: number): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM gnucash_web_category_mappings WHERE id = ${id}
  `;
}

/**
 * Update a mapping's account
 */
export async function updateMapping(id: number, accountGuid: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE gnucash_web_category_mappings SET account_guid = ${accountGuid} WHERE id = ${id}
  `;
}
