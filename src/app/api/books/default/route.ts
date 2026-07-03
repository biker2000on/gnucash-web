import { NextRequest, NextResponse } from 'next/server';
import { createDefaultBook } from '@/lib/default-book';
import { requireAuth } from '@/lib/auth';
import { grantRole } from '@/lib/services/permission.service';
import {
  ENTITY_TYPES,
  saveEntityProfile,
  type EntityType,
  type SaveEntityProfileInput,
} from '@/lib/services/entity.service';

/**
 * POST /api/books/default
 * Create a new book seeded with the account hierarchy recommended for the
 * chosen entity type, and save the book's entity profile.
 *
 * Body: {
 *   name?: string,
 *   description?: string,
 *   currency?: string,     // ISO 4217, default 'USD'
 *   entityType?: string,   // one of ENTITY_TYPES, default 'household'
 *   entityName?: string,
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAuth();
    if (authResult instanceof NextResponse) return authResult;
    const { user } = authResult;

    const body = await request.json().catch(() => ({}));
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'My Finances';
    const description = typeof body.description === 'string' ? body.description : undefined;
    const currency = typeof body.currency === 'string' && body.currency.trim() ? body.currency.trim() : 'USD';
    const entityName = typeof body.entityName === 'string' && body.entityName.trim() ? body.entityName.trim() : null;

    const entityType: EntityType = body.entityType ?? 'household';
    if (!ENTITY_TYPES.includes(entityType)) {
      return NextResponse.json(
        { error: `Invalid entity type: ${String(body.entityType)}` },
        { status: 400 }
      );
    }

    const bookGuid = await createDefaultBook(name, description, entityType, currency);

    // Grant the creating user admin access so the book shows up in their list
    await grantRole(user.id, bookGuid, 'admin', user.id);

    // Persist the entity profile for the new book
    const members: SaveEntityProfileInput['members'] =
      entityType === 'household'
        ? [{ role: 'self', coveredByEmployerPlan: true, sortOrder: 0 }]
        : [];
    await saveEntityProfile(bookGuid, { entityType, entityName, members });

    return NextResponse.json({ success: true, bookGuid });
  } catch (error) {
    console.error('Error creating default book:', error);
    const message = error instanceof Error ? error.message : 'Failed to create default book';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
