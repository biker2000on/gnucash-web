import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    updateFundingRule,
    setFundingRuleActive,
    deleteFundingRule,
    parseFundingRuleInput,
    FundingRuleError,
} from '@/lib/services/funding-rules.service';

function parseId(idParam: string): number | null {
    const id = parseInt(idParam, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * PATCH /api/budgets/funding-rules/{id}
 * Body { active: boolean } toggles the rule; a full body replaces its fields.
 */
export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const { id: idParam } = await params;
        const id = parseId(idParam);
        if (id === null) {
            return NextResponse.json({ error: 'Invalid rule id' }, { status: 400 });
        }

        const body = await request.json().catch(() => null) as Record<string, unknown> | null;

        // Lightweight active toggle (no other fields present)
        if (body && typeof body.active === 'boolean' && Object.keys(body).length === 1) {
            const rule = await setFundingRuleActive(bookGuid, id, body.active);
            if (!rule) return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
            return NextResponse.json(rule);
        }

        const input = parseFundingRuleInput(body);
        const rule = await updateFundingRule(bookGuid, id, input);
        if (!rule) return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
        return NextResponse.json(rule);
    } catch (error) {
        if (error instanceof FundingRuleError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        console.error('Error updating funding rule:', error);
        return NextResponse.json({ error: 'Failed to update funding rule' }, { status: 500 });
    }
}

/**
 * DELETE /api/budgets/funding-rules/{id}
 */
export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const { id: idParam } = await params;
        const id = parseId(idParam);
        if (id === null) {
            return NextResponse.json({ error: 'Invalid rule id' }, { status: 400 });
        }

        const deleted = await deleteFundingRule(bookGuid, id);
        if (!deleted) return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error deleting funding rule:', error);
        return NextResponse.json({ error: 'Failed to delete funding rule' }, { status: 500 });
    }
}
