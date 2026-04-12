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

  const mappings = await prisma.gnucash_web_category_mappings.findMany({
    where: { book_guid: bookGuid, source },
    select: { keyword: true, keyword_normalized: true, account_guid: true, use_count: true },
  });

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

  const now = new Date();

  await prisma.gnucash_web_category_mappings.upsert({
    where: {
      book_guid_source_keyword_normalized: {
        book_guid: bookGuid,
        source,
        keyword_normalized: keywordNormalized,
      },
    },
    create: {
      book_guid: bookGuid,
      source,
      keyword,
      keyword_normalized: keywordNormalized,
      account_guid: accountGuid,
      use_count: 1,
      last_used_at: now,
      created_at: now,
    },
    update: {
      use_count: { increment: 1 },
      last_used_at: now,
      account_guid: accountGuid,
    },
  });
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
  const where: { book_guid: string; source?: string } = { book_guid: bookGuid };
  if (source) {
    where.source = source;
  }

  const rows = await prisma.gnucash_web_category_mappings.findMany({
    where,
    orderBy: { last_used_at: 'desc' },
    select: {
      id: true,
      keyword: true,
      keyword_normalized: true,
      account_guid: true,
      use_count: true,
      last_used_at: true,
    },
  });

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
  await prisma.gnucash_web_category_mappings.deleteMany({
    where: { id },
  });
}

/**
 * Update a mapping's account
 */
export async function updateMapping(id: number, accountGuid: string): Promise<void> {
  await prisma.gnucash_web_category_mappings.update({
    where: { id },
    data: { account_guid: accountGuid },
  });
}
