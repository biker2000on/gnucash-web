import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import prisma from '@/lib/prisma';
import {
    createPriceAlert,
    listPriceAlerts,
    PriceAlertValidationError,
    type PriceAlertRecord,
} from '@/lib/price-alerts';

async function serializeAlerts(alerts: PriceAlertRecord[]) {
    const guids = [...new Set(alerts.map(a => a.commodityGuid))];
    const commodities = guids.length > 0
        ? await prisma.commodities.findMany({
            where: { guid: { in: guids } },
            select: { guid: true, mnemonic: true, fullname: true },
        })
        : [];
    const byGuid = new Map(commodities.map(c => [c.guid, c]));

    return alerts.map(a => {
        const commodity = byGuid.get(a.commodityGuid);
        return {
            id: a.id,
            commodityGuid: a.commodityGuid,
            mnemonic: commodity?.mnemonic ?? a.commodityGuid,
            fullname: commodity?.fullname ?? null,
            direction: a.direction,
            threshold: a.threshold,
            enabled: a.enabled,
            lastTriggeredAt: a.lastTriggeredAt?.toISOString() ?? null,
            createdAt: a.createdAt.toISOString(),
        };
    });
}

/** GET /api/investments/price-alerts — the current user's alerts for the active book. */
export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const alerts = await listPriceAlerts(roleResult.user.id, roleResult.bookGuid);
        return NextResponse.json({ alerts: await serializeAlerts(alerts) });
    } catch (error) {
        console.error('Error listing price alerts:', error);
        return NextResponse.json({ error: 'Failed to list price alerts' }, { status: 500 });
    }
}

/**
 * POST /api/investments/price-alerts — create an alert.
 * Body: { commodityGuid, direction: 'above'|'below', threshold }
 */
export async function POST(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }

        const commodity = typeof body.commodityGuid === 'string'
            ? await prisma.commodities.findUnique({
                where: { guid: body.commodityGuid },
                select: { guid: true },
            })
            : null;
        if (!commodity) {
            return NextResponse.json({ error: 'Unknown commodity' }, { status: 400 });
        }

        const alert = await createPriceAlert(roleResult.user.id, roleResult.bookGuid, {
            commodityGuid: body.commodityGuid,
            direction: body.direction,
            threshold: body.threshold,
        });

        return NextResponse.json({ alert: (await serializeAlerts([alert]))[0] }, { status: 201 });
    } catch (error) {
        if (error instanceof PriceAlertValidationError) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        console.error('Error creating price alert:', error);
        return NextResponse.json({ error: 'Failed to create price alert' }, { status: 500 });
    }
}
