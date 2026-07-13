import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    deletePriceAlert,
    updatePriceAlert,
    PriceAlertValidationError,
} from '@/lib/price-alerts';

function parseId(idParam: string): number | null {
    const id = parseInt(idParam, 10);
    return Number.isInteger(id) ? id : null;
}

/**
 * PATCH /api/investments/price-alerts/[id] — update an alert (own alerts only).
 * Body: { enabled?, direction?, threshold? }
 */
export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { id: idParam } = await params;
        const id = parseId(idParam);
        if (id === null) {
            return NextResponse.json({ error: 'Invalid alert id' }, { status: 400 });
        }

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }

        const updated = await updatePriceAlert(roleResult.user.id, id, {
            enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
            direction: body.direction,
            threshold: body.threshold,
        });
        if (!updated) {
            return NextResponse.json({ error: 'Alert not found' }, { status: 404 });
        }

        return NextResponse.json({
            alert: {
                id: updated.id,
                commodityGuid: updated.commodityGuid,
                direction: updated.direction,
                threshold: updated.threshold,
                enabled: updated.enabled,
                lastTriggeredAt: updated.lastTriggeredAt?.toISOString() ?? null,
                createdAt: updated.createdAt.toISOString(),
            },
        });
    } catch (error) {
        if (error instanceof PriceAlertValidationError) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        console.error('Error updating price alert:', error);
        return NextResponse.json({ error: 'Failed to update price alert' }, { status: 500 });
    }
}

/** DELETE /api/investments/price-alerts/[id] — delete an alert (own alerts only). */
export async function DELETE(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { id: idParam } = await params;
        const id = parseId(idParam);
        if (id === null) {
            return NextResponse.json({ error: 'Invalid alert id' }, { status: 400 });
        }

        const deleted = await deletePriceAlert(roleResult.user.id, id);
        if (!deleted) {
            return NextResponse.json({ error: 'Alert not found' }, { status: 404 });
        }
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error deleting price alert:', error);
        return NextResponse.json({ error: 'Failed to delete price alert' }, { status: 500 });
    }
}
