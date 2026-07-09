/**
 * Maps invoice-engine errors to HTTP responses for the business API routes.
 */

import { NextResponse } from 'next/server';
import {
  InvoiceValidationError,
  InvoiceNotFoundError,
  InvoiceStateError,
} from './invoice-engine';

export function mapInvoiceError(error: unknown): NextResponse {
  if (error instanceof InvoiceValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof InvoiceNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof InvoiceStateError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  console.error('Invoice API error:', error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
