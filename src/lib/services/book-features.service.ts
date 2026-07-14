/**
 * Book feature service — resolves which feature modules are enabled for a
 * book: entity-type defaults (src/lib/book-features.ts) plus admin overrides
 * stored in gnucash_web_book_features.
 */

import prisma from '@/lib/prisma';
import { getEntityProfile } from '@/lib/services/entity.service';
import {
  BOOK_FEATURE_KEYS,
  resolveBookFeatures,
  type BookFeatureKey,
  type ResolvedBookFeatures,
} from '@/lib/book-features';

export async function getBookFeatureOverrides(
  bookGuid: string
): Promise<Partial<Record<BookFeatureKey, boolean>>> {
  const rows = await prisma.gnucash_web_book_features.findMany({
    where: { book_guid: bookGuid },
  });
  const overrides: Partial<Record<BookFeatureKey, boolean>> = {};
  for (const row of rows) {
    if ((BOOK_FEATURE_KEYS as string[]).includes(row.feature_key)) {
      overrides[row.feature_key as BookFeatureKey] = row.enabled;
    }
  }
  return overrides;
}

export async function getResolvedBookFeatures(
  bookGuid: string,
  userId: number
): Promise<ResolvedBookFeatures> {
  const [profile, overrides] = await Promise.all([
    getEntityProfile(bookGuid, userId),
    getBookFeatureOverrides(bookGuid),
  ]);
  return resolveBookFeatures(profile.entityType, overrides);
}

/**
 * Set (true/false) or clear (null = revert to entity-type default) a single
 * module override.
 */
export async function setBookFeatureOverride(
  bookGuid: string,
  key: BookFeatureKey,
  enabled: boolean | null
): Promise<void> {
  if (enabled === null) {
    await prisma.gnucash_web_book_features.deleteMany({
      where: { book_guid: bookGuid, feature_key: key },
    });
    return;
  }
  await prisma.gnucash_web_book_features.upsert({
    where: { book_guid_feature_key: { book_guid: bookGuid, feature_key: key } },
    create: { book_guid: bookGuid, feature_key: key, enabled },
    update: { enabled, updated_at: new Date() },
  });
}
