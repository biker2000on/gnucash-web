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
    // `fields` is present only for the multi-field validations (item posting
    // accounts); omitted otherwise so the existing { error } shape is intact.
    return NextResponse.json(
      error.fields ? { error: error.message, fields: error.fields } : { error: error.message },
      { status: 400 },
    );
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
