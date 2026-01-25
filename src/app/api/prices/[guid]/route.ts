import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { toDecimal, fromDecimal } from '@/lib/prisma';
import { z } from 'zod';

// Schema for updating a price
const UpdatePriceSchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional(),
    value: z.number().positive('Price must be positive').optional(),
    source: z.string().max(2048).optional(),
    type: z.string().max(2048).optional(),
});

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { guid } = await params;

        const price = await prisma.prices.findUnique({
            where: { guid },
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
                        fraction: true,
                    },
                },
            },
        });

        if (!price) {
            return NextResponse.json(
                { error: 'Price not found' },
                { status: 404 }
            );
        }

        return NextResponse.json({
            guid: price.guid,
            commodity_guid: price.commodity_guid,
            currency_guid: price.currency_guid,
            date: price.date.toISOString().split('T')[0],
            value: toDecimal(price.value_num, price.value_denom),
            source: price.source,
            type: price.type,
            commodity: price.commodity,
            currency: price.currency,
        });
    } catch (error) {
        console.error('Error fetching price:', error);
        return NextResponse.json(
            { error: 'Failed to fetch price' },
            { status: 500 }
        );
    }
}

export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { guid } = await params;
        const body = await request.json();

        const parseResult = UpdatePriceSchema.safeParse(body);

        if (!parseResult.success) {
            return NextResponse.json(
                { error: 'Validation failed', errors: parseResult.error.issues },
                { status: 400 }
            );
        }

        // Check if price exists
        const existingPrice = await prisma.prices.findUnique({
            where: { guid },
            include: {
                currency: {
                    select: { fraction: true },
                },
            },
        });

        if (!existingPrice) {
            return NextResponse.json(
                { error: 'Price not found' },
                { status: 404 }
            );
        }

        const data = parseResult.data;
        const updateData: {
            date?: Date;
            value_num?: bigint;
            value_denom?: bigint;
            source?: string;
            type?: string;
        } = {};

        if (data.date) {
            updateData.date = new Date(data.date + 'T12:00:00Z');
        }

        if (data.value !== undefined) {
            const { num, denom } = fromDecimal(data.value, existingPrice.currency.fraction);
            updateData.value_num = num;
            updateData.value_denom = denom;
        }

        if (data.source !== undefined) updateData.source = data.source;
        if (data.type !== undefined) updateData.type = data.type;

        const updatedPrice = await prisma.prices.update({
            where: { guid },
            data: updateData,
        });

        return NextResponse.json({
            guid: updatedPrice.guid,
            commodity_guid: updatedPrice.commodity_guid,
            currency_guid: updatedPrice.currency_guid,
            date: updatedPrice.date.toISOString().split('T')[0],
            value: toDecimal(updatedPrice.value_num, updatedPrice.value_denom),
            source: updatedPrice.source,
            type: updatedPrice.type,
        });
    } catch (error) {
        console.error('Error updating price:', error);
        return NextResponse.json(
            { error: 'Failed to update price' },
            { status: 500 }
        );
    }
}

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { guid } = await params;

        // Check if price exists
        const existingPrice = await prisma.prices.findUnique({
            where: { guid },
        });

        if (!existingPrice) {
            return NextResponse.json(
                { error: 'Price not found' },
                { status: 404 }
            );
        }

        await prisma.prices.delete({
            where: { guid },
        });

        return new NextResponse(null, { status: 204 });
    } catch (error) {
        console.error('Error deleting price:', error);
        return NextResponse.json(
            { error: 'Failed to delete price' },
            { status: 500 }
        );
    }
}
