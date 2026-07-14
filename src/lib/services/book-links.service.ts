/**
 * Book links — a business book points at the household book(s) of its
 * owner(s) with an ownership percent. This is entity-level linking (NOT
 * transaction mirroring): it powers cross-book 1040 aggregation (the
 * household estimator picks up its share of linked business profit), the
 * S-corp analyzer's household marginal-rate context, and self-employed
 * retirement capacity.
 */

import prisma from '@/lib/prisma';
import { getEntityProfile, type EntityType } from '@/lib/services/entity.service';

export class BookLinkValidationError extends Error {}

export interface BookLink {
  businessBookGuid: string;
  householdBookGuid: string;
  /** 0–100 */
  ownershipPercent: number;
}

export interface BookLinkWithNames extends BookLink {
  businessBookName: string | null;
  householdBookName: string | null;
  businessEntityType: EntityType | null;
  businessEntityName: string | null;
}

const BUSINESS_LINKABLE_TYPES: EntityType[] = [
  'sole_prop',
  'llc_single',
  'llc_partnership',
  's_corp',
  'c_corp',
];

export function isLinkableBusinessType(entityType: EntityType): boolean {
  return BUSINESS_LINKABLE_TYPES.includes(entityType);
}

/** Outgoing links from a business book to household books. */
export async function getLinksForBusinessBook(businessBookGuid: string): Promise<BookLinkWithNames[]> {
  const rows = await prisma.gnucash_web_book_links.findMany({
    where: { business_book_guid: businessBookGuid },
    orderBy: { household_book_guid: 'asc' },
  });
  return decorate(rows);
}

/** Incoming links: business books whose profit flows to this household book. */
export async function getLinksToHouseholdBook(householdBookGuid: string): Promise<BookLinkWithNames[]> {
  const rows = await prisma.gnucash_web_book_links.findMany({
    where: { household_book_guid: householdBookGuid },
    orderBy: { business_book_guid: 'asc' },
  });
  return decorate(rows);
}

async function decorate(
  rows: Array<{ business_book_guid: string; household_book_guid: string; ownership_percent: number }>
): Promise<BookLinkWithNames[]> {
  if (rows.length === 0) return [];
  const guids = [...new Set(rows.flatMap(r => [r.business_book_guid, r.household_book_guid]))];
  const [books, profiles] = await Promise.all([
    prisma.books.findMany({ where: { guid: { in: guids } }, select: { guid: true, name: true } }),
    prisma.gnucash_web_entity_profiles.findMany({
      where: { book_guid: { in: guids } },
      select: { book_guid: true, entity_type: true, entity_name: true },
    }),
  ]);
  const nameOf = new Map(books.map(b => [b.guid, b.name]));
  const profileOf = new Map(profiles.map(p => [p.book_guid, p]));
  return rows.map(r => ({
    businessBookGuid: r.business_book_guid,
    householdBookGuid: r.household_book_guid,
    ownershipPercent: r.ownership_percent,
    businessBookName: nameOf.get(r.business_book_guid) ?? null,
    householdBookName: nameOf.get(r.household_book_guid) ?? null,
    businessEntityType: (profileOf.get(r.business_book_guid)?.entity_type as EntityType) ?? null,
    businessEntityName: profileOf.get(r.business_book_guid)?.entity_name ?? null,
  }));
}

export interface SetBookLinksInput {
  links: Array<{ householdBookGuid: string; ownershipPercent: number }>;
}

/**
 * Replace all outgoing links for a business book. Validates that the source
 * book is a linkable business type, each target book exists and is a
 * household book, percents are 0–100, and the total doesn't exceed 100
 * (a partnership can split ownership across multiple linked households).
 */
export async function setBookLinks(
  businessBookGuid: string,
  userId: number,
  input: SetBookLinksInput
): Promise<BookLinkWithNames[]> {
  const profile = await getEntityProfile(businessBookGuid, userId);
  if (!isLinkableBusinessType(profile.entityType)) {
    throw new BookLinkValidationError(
      `Book links are only available on business books (sole prop, LLC, S-Corp, C-Corp); this book is ${profile.entityType}.`
    );
  }

  const seen = new Set<string>();
  let total = 0;
  for (const link of input.links) {
    if (link.householdBookGuid === businessBookGuid) {
      throw new BookLinkValidationError('A book cannot link to itself.');
    }
    if (seen.has(link.householdBookGuid)) {
      throw new BookLinkValidationError('Duplicate household book in links.');
    }
    seen.add(link.householdBookGuid);
    if (
      typeof link.ownershipPercent !== 'number' ||
      !isFinite(link.ownershipPercent) ||
      link.ownershipPercent <= 0 ||
      link.ownershipPercent > 100
    ) {
      throw new BookLinkValidationError('Ownership percent must be between 0 and 100.');
    }
    total += link.ownershipPercent;
  }
  if (total > 100.0001) {
    throw new BookLinkValidationError('Total ownership across linked households cannot exceed 100%.');
  }

  for (const link of input.links) {
    const book = await prisma.books.findUnique({
      where: { guid: link.householdBookGuid },
      select: { guid: true },
    });
    if (!book) {
      throw new BookLinkValidationError(`Household book not found: ${link.householdBookGuid}`);
    }
    const target = await getEntityProfile(link.householdBookGuid, userId);
    if (target.entityType !== 'household') {
      throw new BookLinkValidationError(
        `Linked book must be a household book; ${link.householdBookGuid} is ${target.entityType}.`
      );
    }
  }

  await prisma.$transaction([
    prisma.gnucash_web_book_links.deleteMany({ where: { business_book_guid: businessBookGuid } }),
    prisma.gnucash_web_book_links.createMany({
      data: input.links.map(l => ({
        business_book_guid: businessBookGuid,
        household_book_guid: l.householdBookGuid,
        ownership_percent: l.ownershipPercent,
      })),
    }),
  ]);

  return getLinksForBusinessBook(businessBookGuid);
}
