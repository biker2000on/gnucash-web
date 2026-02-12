/**
 * Depreciation Schedules API
 *
 * GET /api/assets/schedules - Get all schedules
 * GET /api/assets/schedules?accountGuid=X - Get schedule for specific account
 * POST /api/assets/schedules - Create a new schedule
 * PUT /api/assets/schedules?id=X - Update an existing schedule
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

export async function GET(request: NextRequest) {
  try {
    const accountGuid = request.nextUrl.searchParams.get('accountGuid');

    if (accountGuid) {
      const schedule = await prisma.gnucash_web_depreciation_schedules.findUnique({
        where: { account_guid: accountGuid },
      });

      if (!schedule) {
        return NextResponse.json({ schedule: null });
      }

      return NextResponse.json({
        schedule: serializeSchedule(schedule),
      });
    }

    const schedules = await prisma.gnucash_web_depreciation_schedules.findMany({
      orderBy: { created_at: 'desc' },
    });

    return NextResponse.json({
      schedules: schedules.map(serializeSchedule),
    });
  } catch (err) {
    console.error('Error fetching schedules:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      accountGuid,
      purchasePrice,
      purchaseDate,
      usefulLifeYears,
      salvageValue,
      method,
      declineRate,
      contraAccountGuid,
      frequency,
      isAppreciation,
      notes,
    } = body;

    if (!accountGuid || purchasePrice == null || !purchaseDate || !usefulLifeYears || !method || !contraAccountGuid) {
      return NextResponse.json(
        { error: 'Missing required fields: accountGuid, purchasePrice, purchaseDate, usefulLifeYears, method, contraAccountGuid' },
        { status: 400 }
      );
    }

    if (method !== 'straight-line' && method !== 'declining-balance') {
      return NextResponse.json(
        { error: 'method must be "straight-line" or "declining-balance"' },
        { status: 400 }
      );
    }

    // Upsert: one schedule per account
    const schedule = await prisma.gnucash_web_depreciation_schedules.upsert({
      where: { account_guid: accountGuid },
      create: {
        account_guid: accountGuid,
        purchase_price: purchasePrice,
        purchase_date: new Date(purchaseDate),
        useful_life_years: usefulLifeYears,
        salvage_value: salvageValue ?? 0,
        method,
        decline_rate: method === 'declining-balance' ? (declineRate ?? 2 / usefulLifeYears) : null,
        contra_account_guid: contraAccountGuid,
        frequency: frequency ?? 'monthly',
        is_appreciation: isAppreciation ?? false,
        notes: notes ?? null,
      },
      update: {
        purchase_price: purchasePrice,
        purchase_date: new Date(purchaseDate),
        useful_life_years: usefulLifeYears,
        salvage_value: salvageValue ?? 0,
        method,
        decline_rate: method === 'declining-balance' ? (declineRate ?? 2 / usefulLifeYears) : null,
        contra_account_guid: contraAccountGuid,
        frequency: frequency ?? 'monthly',
        is_appreciation: isAppreciation ?? false,
        notes: notes ?? null,
        updated_at: new Date(),
      },
    });

    return NextResponse.json({ schedule: serializeSchedule(schedule) });
  } catch (err) {
    console.error('Error creating schedule:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'Missing id query parameter' }, { status: 400 });
    }

    const body = await request.json();
    const {
      purchasePrice,
      purchaseDate,
      usefulLifeYears,
      salvageValue,
      method,
      declineRate,
      contraAccountGuid,
      frequency,
      isAppreciation,
      enabled,
      notes,
    } = body;

    const updateData: Record<string, unknown> = { updated_at: new Date() };

    if (purchasePrice != null) updateData.purchase_price = purchasePrice;
    if (purchaseDate) updateData.purchase_date = new Date(purchaseDate);
    if (usefulLifeYears != null) updateData.useful_life_years = usefulLifeYears;
    if (salvageValue != null) updateData.salvage_value = salvageValue;
    if (method) updateData.method = method;
    if (declineRate != null) updateData.decline_rate = declineRate;
    if (contraAccountGuid) updateData.contra_account_guid = contraAccountGuid;
    if (frequency) updateData.frequency = frequency;
    if (isAppreciation != null) updateData.is_appreciation = isAppreciation;
    if (enabled != null) updateData.enabled = enabled;
    if (notes !== undefined) updateData.notes = notes;

    const schedule = await prisma.gnucash_web_depreciation_schedules.update({
      where: { id: parseInt(id) },
      data: updateData,
    });

    return NextResponse.json({ schedule: serializeSchedule(schedule) });
  } catch (err) {
    console.error('Error updating schedule:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeSchedule(schedule: any) {
  return {
    id: schedule.id,
    accountGuid: schedule.account_guid,
    purchasePrice: Number(schedule.purchase_price),
    purchaseDate: schedule.purchase_date instanceof Date
      ? schedule.purchase_date.toISOString().split('T')[0]
      : String(schedule.purchase_date).split('T')[0],
    usefulLifeYears: schedule.useful_life_years,
    salvageValue: Number(schedule.salvage_value),
    method: schedule.method,
    declineRate: schedule.decline_rate ? Number(schedule.decline_rate) : null,
    contraAccountGuid: schedule.contra_account_guid,
    frequency: schedule.frequency,
    isAppreciation: schedule.is_appreciation,
    lastTransactionDate: schedule.last_transaction_date
      ? (schedule.last_transaction_date instanceof Date
          ? schedule.last_transaction_date.toISOString().split('T')[0]
          : String(schedule.last_transaction_date).split('T')[0])
      : null,
    enabled: schedule.enabled,
    notes: schedule.notes,
    createdAt: schedule.created_at instanceof Date
      ? schedule.created_at.toISOString()
      : String(schedule.created_at),
    updatedAt: schedule.updated_at instanceof Date
      ? schedule.updated_at.toISOString()
      : String(schedule.updated_at),
  };
}
