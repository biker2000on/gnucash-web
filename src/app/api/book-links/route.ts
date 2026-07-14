// src/app/api/book-links/route.ts
//
// Entity-level book links for the active book.
// GET: outgoing links (business book → households) and incoming links
//      (household book ← businesses), plus linkable candidate books.
// PUT (admin): replace the active business book's outgoing links
//      { links: [{ householdBookGuid, ownershipPercent }] }.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { getEntityProfile } from '@/lib/services/entity.service';
import { getUserBooks } from '@/lib/services/permission.service';
import prisma from '@/lib/prisma';
import {
  getLinksForBusinessBook,
  getLinksToHouseholdBook,
  setBookLinks,
  isLinkableBusinessType,
  BookLinkValidationError,
} from '@/lib/services/book-links.service';

export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const bookGuid = await getActiveBookGuid();
    const profile = await getEntityProfile(bookGuid, roleResult.user.id);

    const [outgoing, incoming] = await Promise.all([
      getLinksForBusinessBook(bookGuid),
      getLinksToHouseholdBook(bookGuid),
    ]);

    // Household books the user can access — candidates for linking. Only
    // offered when the active book is a linkable business type.
    let candidates: Array<{ guid: string; name: string | null }> = [];
    if (isLinkableBusinessType(profile.entityType)) {
      const userBooks = await getUserBooks(roleResult.user.id);
      const guids = userBooks.map(b => b.guid).filter(g => g !== bookGuid);
      if (guids.length > 0) {
        const profiles = await prisma.gnucash_web_entity_profiles.findMany({
          where: { book_guid: { in: guids } },
          select: { book_guid: true, entity_type: true },
        });
        const typeOf = new Map(profiles.map(p => [p.book_guid, p.entity_type]));
        // Books without a profile row default to household
        const householdGuids = guids.filter(g => (typeOf.get(g) ?? 'household') === 'household');
        const books = await prisma.books.findMany({
          where: { guid: { in: householdGuids } },
          select: { guid: true, name: true },
        });
        candidates = books;
      }
    }

    return NextResponse.json({
      entityType: profile.entityType,
      linkable: isLinkableBusinessType(profile.entityType),
      outgoing,
      incoming,
      candidates,
    });
  } catch (error) {
    console.error('Error fetching book links:', error);
    return NextResponse.json({ error: 'Failed to fetch book links' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    if (!Array.isArray(body?.links)) {
      return NextResponse.json(
        { error: 'links must be an array of { householdBookGuid, ownershipPercent }' },
        { status: 400 }
      );
    }
    for (const link of body.links) {
      if (!link || typeof link.householdBookGuid !== 'string' || link.householdBookGuid.length !== 32) {
        return NextResponse.json({ error: 'Each link needs a valid householdBookGuid' }, { status: 400 });
      }
    }

    const bookGuid = await getActiveBookGuid();
    const outgoing = await setBookLinks(bookGuid, roleResult.user.id, {
      links: body.links.map((l: { householdBookGuid: string; ownershipPercent?: number }) => ({
        householdBookGuid: l.householdBookGuid,
        ownershipPercent:
          typeof l.ownershipPercent === 'number' ? l.ownershipPercent : 100,
      })),
    });
    return NextResponse.json({ outgoing });
  } catch (error) {
    if (error instanceof BookLinkValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error saving book links:', error);
    return NextResponse.json({ error: 'Failed to save book links' }, { status: 500 });
  }
}
