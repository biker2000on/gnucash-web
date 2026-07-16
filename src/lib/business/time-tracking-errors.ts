/**
 * Maps time-tracking service errors to HTTP responses (400 / 404 / 409).
 * Separate from api-errors.ts to keep that shared file untouched.
 */

import { NextResponse } from 'next/server';
import {
  TimeTrackingValidationError,
  TimeTrackingNotFoundError,
  TimeTrackingStateError,
} from './time-tracking.service';

export function mapTimeTrackingError(error: unknown, context: string): NextResponse {
  if (error instanceof TimeTrackingValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof TimeTrackingNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof TimeTrackingStateError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  console.error(`Time tracking API error (${context}):`, error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
