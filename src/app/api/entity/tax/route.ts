// src/app/api/entity/tax/route.ts
//
// Partial update of the active book's tax profile fields (filing status,
// state, flat rate). Used by the tax estimator's inline controls so they are
// book-scoped: editing Bee Club's tax settings must never touch another
// book's. Materializes a synthesized household profile on first write.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import {
  updateBookTaxProfile,
  EntityValidationError,
  type UpdateBookTaxFieldsInput,
} from '@/lib/services/entity.service';
import { FILING_STATUSES } from '@/lib/tax/types';

export async function PUT(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    const fields: UpdateBookTaxFieldsInput = {};

    if (body?.filingStatus !== undefined) {
      if (
        body.filingStatus !== null &&
        !(FILING_STATUSES as readonly string[]).includes(body.filingStatus)
      ) {
        return NextResponse.json(
          { error: `Invalid filingStatus. Must be one of: ${FILING_STATUSES.join(', ')}` },
          { status: 400 }
        );
      }
      fields.filingStatus = body.filingStatus;
    }
    if (body?.taxState !== undefined) {
      if (body.taxState !== null && typeof body.taxState !== 'string') {
        return NextResponse.json({ error: 'taxState must be a string or null' }, { status: 400 });
      }
      fields.taxState = body.taxState;
    }
    if (body?.stateFlatRate !== undefined) {
      if (
        body.stateFlatRate !== null &&
        (typeof body.stateFlatRate !== 'number' || !isFinite(body.stateFlatRate))
      ) {
        return NextResponse.json(
          { error: 'stateFlatRate must be a number or null' },
          { status: 400 }
        );
      }
      fields.stateFlatRate = body.stateFlatRate;
    }

    if (Object.keys(fields).length === 0) {
      return NextResponse.json(
        { error: 'Provide at least one of filingStatus, taxState, stateFlatRate' },
        { status: 400 }
      );
    }

    const bookGuid = await getActiveBookGuid();
    const profile = await updateBookTaxProfile(bookGuid, roleResult.user.id, fields);
    return NextResponse.json(profile);
  } catch (error) {
    if (error instanceof EntityValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error updating book tax profile:', error);
    return NextResponse.json({ error: 'Failed to update tax profile' }, { status: 500 });
  }
}
