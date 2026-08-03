import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { generateGuid, fromDecimal, toDecimal } from '@/lib/prisma';
import { MAX_INT64 } from '@/lib/gnucash';
import { PRICE_DENOM } from '@/lib/yahoo-price-service';
import { getAllExchangeRates, getCurrencyByMnemonic } from '@/lib/currency';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { cacheInvalidateFrom } from '@/lib/cache';
import { publishDataChange } from '@/lib/data-events';

// Schema for creating a new exchange rate
const CreateExchangeRateSchema = z.object({
    from_currency: z.string().length(3, 'Currency code must be 3 characters'),
    to_currency: z.string().length(3, 'Currency code must be 3 characters'),
    rate: z.number().positive('Rate must be positive'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
    source: z.string().max(2048).optional().default('user:manual'),
});

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const baseCurrency = searchParams.get('base') || 'USD';

        // Get base currency
        const base = await getCurrencyByMnemonic(baseCurrency);
        if (!base) {
            return NextResponse.json(
                { error: `Currency ${baseCurrency} not found` },
                { status: 404 }
            );
        }

        // Get all exchange rates relative to base
        const rates = await getAllExchangeRates(base.guid);

        return NextResponse.json({
            base: {
                mnemonic: base.mnemonic,
                fullname: base.fullname,
            },
            rates: rates.map(r => ({
                fromCurrency: r.fromCurrency,
                toCurrency: r.toCurrency,
                rate: r.rate,
                date: r.date.toISOString().split('T')[0],
                source: r.source,
            })),
        });
    } catch (error) {
        console.error('Error fetching exchange rates:', error);
        return NextResponse.json(
            { error: 'Failed to fetch exchange rates' },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json();
        const parseResult = CreateExchangeRateSchema.safeParse(body);

        if (!parseResult.success) {
            return NextResponse.json(
                { error: 'Validation failed', errors: parseResult.error.issues },
                { status: 400 }
            );
        }

        const data = parseResult.data;

        // Get from currency
        const fromCurrency = await getCurrencyByMnemonic(data.from_currency);
        if (!fromCurrency) {
            return NextResponse.json(
                { error: `Currency ${data.from_currency} not found` },
                { status: 404 }
            );
        }

        // Get to currency
        const toCurrency = await getCurrencyByMnemonic(data.to_currency);
        if (!toCurrency) {
            return NextResponse.json(
                { error: `Currency ${data.to_currency} not found` },
                { status: 404 }
            );
        }

        // Generate GUID and convert value to fraction.
        // Rates are stored at PRICE_DENOM, not the currency's 1/100 fraction:
        // 1.0857 must not become 1.09, and 0.00072 must not become 0.
        const guid = generateGuid();
        const { num, denom } = fromDecimal(data.rate, PRICE_DENOM);
        if (num <= 0n || num > MAX_INT64) {
            return NextResponse.json(
                { error: 'Rate is outside the storable range' },
                { status: 400 }
            );
        }
        const rateDate = new Date(data.date + 'T12:00:00Z');

        // Upsert on the (commodity, currency, date) unique key: a same-day
        // re-entry is an intentional correction, so update the rate in place
        // instead of racing a duplicate insert.
        const price = await prisma.prices.upsert({
            where: {
                commodity_guid_currency_guid_date: {
                    commodity_guid: fromCurrency.guid,
                    currency_guid: toCurrency.guid,
                    date: rateDate,
                },
            },
            update: {
                value_num: num,
                value_denom: denom,
                source: data.source,
                type: 'last',
            },
            create: {
                guid,
                commodity_guid: fromCurrency.guid,
                currency_guid: toCurrency.guid,
                date: rateDate,
                value_num: num,
                value_denom: denom,
                source: data.source,
                type: 'last',
            },
        });

        // Exchange rates feed currency conversion in the dashboard metrics
        try {
            await cacheInvalidateFrom(roleResult.bookGuid, price.date);
        } catch (err) {
            console.warn('Cache invalidation failed:', err);
        }
        void publishDataChange(roleResult.bookGuid, 'prices', { guid: price.guid, action: 'update' });

        return NextResponse.json({
            guid: price.guid,
            fromCurrency: data.from_currency,
            toCurrency: data.to_currency,
            rate: parseFloat(toDecimal(price.value_num, price.value_denom)),
            date: price.date.toISOString().split('T')[0],
            source: price.source,
        }, { status: 201 });
    } catch (error) {
        console.error('Error creating exchange rate:', error);
        return NextResponse.json(
            { error: 'Failed to create exchange rate' },
            { status: 500 }
        );
    }
}
