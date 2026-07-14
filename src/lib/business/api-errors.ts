/**
 * Maps invoice-engine errors to HTTP responses for the business API routes.
 */

import { NextResponse } from 'next/server';
import {
  InvoiceValidationError,
  InvoiceNotFoundError,
  InvoiceStateError,
} from './invoice-engine';
import {
  RecurringInvoiceValidationError,
  RecurringInvoiceNotFoundError,
} from './recurring-invoices';
import {
  PackageValidationError,
  PackageNotFoundError,
  PackageStateError,
} from '@/lib/services/packages.service';
import {
  FundValidationError,
  FundNotFoundError,
  FundStateError,
} from '@/lib/services/funds.service';

/** Maps recurring-invoice service errors (falls through to invoice errors). */
export function mapRecurringError(error: unknown): NextResponse {
  if (error instanceof RecurringInvoiceValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof RecurringInvoiceNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  return mapInvoiceError(error);
}

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

/** Maps prepaid-package service errors to HTTP responses. */
export function mapPackageError(error: unknown): NextResponse {
  if (error instanceof PackageValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof PackageNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof PackageStateError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  console.error('Packages API error:', error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/** Maps restricted-funds service errors to HTTP responses. */
export function mapFundError(error: unknown): NextResponse {
  if (error instanceof FundValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof FundNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof FundStateError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  console.error('Funds API error:', error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
