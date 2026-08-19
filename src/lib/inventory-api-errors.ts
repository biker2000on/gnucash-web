/**
 * Maps inventory service/engine errors to HTTP responses for the
 * /api/inventory routes.
 *
 *   InventoryValidationError → 400  (bad input, missing required accounts)
 *   InventoryNotFoundError   → 404  (unknown item/location/BOM/invoice)
 *   InventoryStockError      → 409  (movement would drive stock below zero)
 *   InventoryStateError      → 409  (duplicate SKU/name, unposted invoice)
 *   SiblingKeyAdoptedError   → 503  (concurrent creator won; retry the request)
 *   anything else            → 500
 */

import { NextResponse } from 'next/server';
import {
  InventoryValidationError,
  InventoryNotFoundError,
  InventoryStockError,
  InventoryStateError,
} from '@/lib/services/inventory.service';
import { PeriodLockedError, periodLockedResponse } from '@/lib/services/period-lock.service';
import { isSiblingKeyAdopted, siblingKeyAdoptedResponse } from '@/lib/sibling-key-adopted-response';

export function mapInventoryError(error: unknown): NextResponse {
  // Transient and retryable — never a 500. See sibling-key-adopted-response.ts.
  if (isSiblingKeyAdopted(error)) {
    return siblingKeyAdoptedResponse(error);
  }
  if (error instanceof PeriodLockedError) {
    return periodLockedResponse(error);
  }
  if (error instanceof InventoryValidationError) {
    // Per-field detail is present only for the multi-field validations (item
    // posting accounts); omitted otherwise so the plain { error } shape stays.
    //
    // It goes out as `errors: [{ field, message }]` — the canonical shape that
    // `extractFieldErrors`/`ApiRequestError.fromBody` in lib/api-error.ts read,
    // and the same one validateTransaction and the domain commands emit. The
    // `fields` map that this route invented is kept alongside it for one
    // release so nothing still reading it breaks; drop it after that.
    if (error.fields) {
      const errors = Object.entries(error.fields).map(([field, message]) => ({ field, message }));
      return NextResponse.json(
        { error: error.message, errors, fields: error.fields },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof InventoryNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof InventoryStockError || error instanceof InventoryStateError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  console.error('Inventory API error:', error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
