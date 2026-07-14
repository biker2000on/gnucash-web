// src/app/api/entity/route.ts
//
// Entity/household profile for the active book.
// GET returns the profile (synthesized from user preferences when none is
// persisted); PUT upserts the profile and replaces its members.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import {
  getEntityProfile,
  saveEntityProfile,
  EntityValidationError,
  ENTITY_TYPES,
  ENTITY_MEMBER_ROLES,
  type EntityType,
  type EntityMemberRole,
  type SaveEntityProfileInput,
} from '@/lib/services/entity.service';

export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const bookGuid = await getActiveBookGuid();
    const profile = await getEntityProfile(bookGuid, roleResult.user.id);
    return NextResponse.json(profile);
  } catch (error) {
    console.error('Error fetching entity profile:', error);
    return NextResponse.json({ error: 'Failed to fetch entity profile' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    const { entityType, entityName, taxState, filingStatus, stateFlatRate, notes, members } =
      body ?? {};

    if (!ENTITY_TYPES.includes(entityType as EntityType)) {
      return NextResponse.json(
        { error: `Invalid entityType. Must be one of: ${ENTITY_TYPES.join(', ')}` },
        { status: 400 }
      );
    }
    if (!Array.isArray(members)) {
      return NextResponse.json({ error: 'members must be an array' }, { status: 400 });
    }
    for (const member of members) {
      if (!member || !ENTITY_MEMBER_ROLES.includes(member.role as EntityMemberRole)) {
        return NextResponse.json(
          { error: `Invalid member role. Must be one of: ${ENTITY_MEMBER_ROLES.join(', ')}` },
          { status: 400 }
        );
      }
    }

    const input: SaveEntityProfileInput = {
      entityType: entityType as EntityType,
      entityName: typeof entityName === 'string' ? entityName : null,
      taxState: typeof taxState === 'string' ? taxState : null,
      // Omitted = keep stored values (the tax estimator manages these inline)
      filingStatus: typeof filingStatus === 'string' ? filingStatus : undefined,
      stateFlatRate:
        typeof stateFlatRate === 'number' && isFinite(stateFlatRate) ? stateFlatRate : undefined,
      notes: typeof notes === 'string' ? notes : null,
      members: members.map((m: Record<string, unknown>, i: number) => ({
        role: m.role as EntityMemberRole,
        name: typeof m.name === 'string' ? m.name : null,
        birthday: typeof m.birthday === 'string' && m.birthday ? m.birthday : null,
        coveredByEmployerPlan: m.coveredByEmployerPlan === true,
        ownershipPercent:
          typeof m.ownershipPercent === 'number' && isFinite(m.ownershipPercent)
            ? m.ownershipPercent
            : null,
        sortOrder: typeof m.sortOrder === 'number' ? m.sortOrder : i,
      })),
    };

    const bookGuid = await getActiveBookGuid();
    const profile = await saveEntityProfile(bookGuid, input);
    return NextResponse.json(profile);
  } catch (error) {
    if (error instanceof EntityValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error saving entity profile:', error);
    return NextResponse.json({ error: 'Failed to save entity profile' }, { status: 500 });
  }
}
