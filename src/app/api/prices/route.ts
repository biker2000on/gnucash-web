import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { toDecimal, fromDecimal, generateGuid } from '@/lib/prisma';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';

// Schema for creating a new price
const CreatePriceSchema = z.object({
    commodity_guid: z.string().length(32, 'Invalid commodity GUID'),
    currency_guid: z.string().length(32, 'Invalid currency GUID'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
    value: z.number().positive('Price must be positive'),
    source: z.string().max(2048).optional().default('user:manual'),
    type: z.string().max(2048).optional().default('last'),
});

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const commodityGuid = searchParams.get('commodity_guid');
        const currencyGuid = searchParams.get('currency_guid');
        const limit = parseInt(searchParams.get('limit') || '100', 10);
        const offset = parseInt(searchParams.get('offset') || '0', 10);

        const where: {
            commodity_guid?: string;
            currency_guid?: string;
        } = {};

        if (commodityGuid) where.commodity_guid = commodityGuid;
        if (currencyGuid) where.currency_guid = currencyGuid;

        const [prices, total] = await Promise.all([
            prisma.prices.findMany({
                where,
                include: {
                    commodity: {
                        select: {
                            mnemonic: true,
                            fullname: true,
                            namespace: true,
                        },
                    },
                    currency: {
                        select: {
                            mnemonic: true,
                            fullname: true,
                        },
                    },
                },
                orderBy: { date: 'desc' },
                take: limit,
                skip: offset,
            }),
            prisma.prices.count({ where }),
        ]);

        return NextResponse.json({
            prices: prices.map(p => ({
                guid: p.guid,
                commodity_guid: p.commodity_guid,
                currency_guid: p.currency_guid,
                date: p.date.toISOString().split('T')[0],
                value: toDecimal(p.value_num, p.value_denom),
                source: p.source,
                type: p.type,
                commodity: p.commodity,
                currency: p.currency,
            })),
            total,
            limit,
            offset,
        });
    } catch (error) {
        console.error('Error fetching prices:', error);
        return NextResponse.json(
            { error: 'Failed to fetch prices' },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json();
        const parseResult = CreatePriceSchema.safeParse(body);

        if (!parseResult.success) {
            return NextResponse.json(
                { error: 'Validation failed', errors: parseResult.error.issues },
                { status: 400 }
            );
        }

        const data = parseResult.data;

        // Verify commodity exists
        const commodity = await prisma.commodities.findUnique({
            where: { guid: data.commodity_guid },
        });

        if (!commodity) {
            return NextResponse.json(
                { error: 'Commodity not found' },
                { status: 404 }
            );
        }

        // Verify currency exists
        const currency = await prisma.commodities.findUnique({
            where: { guid: data.currency_guid },
        });

        if (!currency) {
            return NextResponse.json(
                { error: 'Currency not found' },
                { status: 404 }
            );
        }

        // Generate GUID and convert value to fraction
        const guid = generateGuid();
        const { num, denom } = fromDecimal(data.value, currency.fraction);

        const price = await prisma.prices.create({
            data: {
                guid,
                commodity_guid: data.commodity_guid,
                currency_guid: data.currency_guid,
                date: new Date(data.date + 'T12:00:00Z'),
                value_num: num,
                value_denom: denom,
                source: data.source,
                type: data.type,
            },
        });

        return NextResponse.json({
            guid: price.guid,
            commodity_guid: price.commodity_guid,
            currency_guid: price.currency_guid,
            date: price.date.toISOString().split('T')[0],
            value: toDecimal(price.value_num, price.value_denom),
            source: price.source,
            type: price.type,
        }, { status: 201 });
    } catch (error) {
        console.error('Error creating price:', error);
        return NextResponse.json(
            { error: 'Failed to create price' },
            { status: 500 }
        );
    }
}
