/**
 * Asset Transaction API
 *
 * POST /api/assets/transactions - Create a depreciation/appreciation transaction
 * POST /api/assets/transactions?action=adjust - Adjust to target value
 * POST /api/assets/transactions?action=process-schedule - Process pending schedule
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createValuationTransaction,
  adjustToTargetValue,
  processDepreciationSchedule,
} from '@/lib/asset-transaction-service';

export async function POST(request: NextRequest) {
  try {
    const action = request.nextUrl.searchParams.get('action');
    const body = await request.json();

    if (action === 'adjust') {
      const { assetAccountGuid, contraAccountGuid, targetValue, date, description } = body;
      if (!assetAccountGuid || !contraAccountGuid || targetValue == null || !date) {
        return NextResponse.json(
          { error: 'Missing required fields: assetAccountGuid, contraAccountGuid, targetValue, date' },
          { status: 400 }
        );
      }
      const result = await adjustToTargetValue({
        assetAccountGuid,
        contraAccountGuid,
        targetValue: Number(targetValue),
        date,
        description,
      });
      return NextResponse.json(result);
    }

    if (action === 'process-schedule') {
      const { scheduleId, upToDate } = body;
      if (!scheduleId) {
        return NextResponse.json(
          { error: 'Missing required field: scheduleId' },
          { status: 400 }
        );
      }
      const result = await processDepreciationSchedule(
        Number(scheduleId),
        upToDate ? new Date(upToDate) : undefined
      );
      return NextResponse.json(result);
    }

    // Default: create a single valuation transaction
    const { assetAccountGuid, contraAccountGuid, amount, type, date, description, memo } = body;
    if (!assetAccountGuid || !contraAccountGuid || !amount || !type || !date) {
      return NextResponse.json(
        { error: 'Missing required fields: assetAccountGuid, contraAccountGuid, amount, type, date' },
        { status: 400 }
      );
    }

    if (type !== 'depreciation' && type !== 'appreciation') {
      return NextResponse.json(
        { error: 'type must be "depreciation" or "appreciation"' },
        { status: 400 }
      );
    }

    const result = await createValuationTransaction({
      assetAccountGuid,
      contraAccountGuid,
      amount: Number(amount),
      type,
      date,
      description,
      memo,
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
