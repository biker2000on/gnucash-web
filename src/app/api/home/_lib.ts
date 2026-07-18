import { NextResponse } from 'next/server';
import {
    HomeNotFoundError,
    HomeValidationError,
    type ItemInput,
} from '@/lib/services/home.service';

/** Shared error mapping for the /api/home routes. */
export function handleHomeError(error: unknown, logLabel: string, fallback: string): NextResponse {
    if (error instanceof HomeValidationError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof HomeNotFoundError) {
        return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error(`${logLabel}:`, error);
    return NextResponse.json({ error: fallback }, { status: 500 });
}

export async function parseRouteId(params: Promise<{ id: string }>): Promise<number | null> {
    const { id } = await params;
    const parsed = parseInt(id, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Coerce a JSON body into an ItemInput: absent keys stay undefined
 * (untouched on update), null/'' clears, everything else is coerced.
 */
export function coerceItemInput(body: Record<string, unknown>): ItemInput {
    const opt = <T>(key: string, coerce: (v: unknown) => T): T | null | undefined => {
        if (!(key in body) || body[key] === undefined) return undefined;
        if (body[key] === null || body[key] === '') return null;
        return coerce(body[key]);
    };
    return {
        roomId: body.roomId === undefined ? undefined : Number(body.roomId),
        name: body.name === undefined ? undefined : String(body.name),
        category: opt('category', String),
        estValue: opt('estValue', Number),
        purchaseDate: opt('purchaseDate', String),
        receiptId: opt('receiptId', Number),
        warrantyExpires: opt('warrantyExpires', String),
        serial: opt('serial', String),
        notes: opt('notes', String),
        draft: body.draft === true ? true : undefined,
    };
}
