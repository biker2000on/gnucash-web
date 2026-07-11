/**
 * Maps inventory service/engine errors to HTTP responses for the
 * /api/inventory routes.
 *
 *   InventoryValidationError → 400  (bad input, missing required accounts)
 *   InventoryNotFoundError   → 404  (unknown item/location/BOM/invoice)
 *   InventoryStockError      → 409  (movement would drive stock below zero)
 *   InventoryStateError      → 409  (duplicate SKU/name, unposted invoice)
 *   anything else            → 500
 */

import { NextResponse } from 'next/server';
import {
  InventoryValidationError,
  InventoryNotFoundError,
  InventoryStockError,
  InventoryStateError,
} from '@/lib/services/inventory.service';

export function mapInventoryError(error: unknown): NextResponse {
  if (error instanceof InventoryValidationError) {
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
