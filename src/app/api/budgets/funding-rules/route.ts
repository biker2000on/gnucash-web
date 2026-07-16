import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    listFundingRules,
    listFundingApplications,
    createFundingRule,
    parseFundingRuleInput,
    FundingRuleError,
} from '@/lib/services/funding-rules.service';

/**
 * GET /api/budgets/funding-rules
 * Rules for the active book plus recent sweep applications.
 */
export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const [rules, applications] = await Promise.all([
            listFundingRules(bookGuid),
            listFundingApplications(bookGuid, 50),
        ]);
        return NextResponse.json({ rules, applications });
    } catch (error) {
        console.error('Error listing funding rules:', error);
        return NextResponse.json({ error: 'Failed to load funding rules' }, { status: 500 });
    }
}

/**
 * POST /api/budgets/funding-rules
 * Create a rule.
 */
export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const body = await request.json().catch(() => null);
        const input = parseFundingRuleInput(body);
        const rule = await createFundingRule(bookGuid, input);
        return NextResponse.json(rule, { status: 201 });
    } catch (error) {
        if (error instanceof FundingRuleError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        console.error('Error creating funding rule:', error);
        return NextResponse.json({ error: 'Failed to create funding rule' }, { status: 500 });
    }
}
