/**
 * Natural-language quick-add parser.
 *
 * GET  -> { configured: boolean }   (probe: whether an AI provider is set up)
 * POST -> { text } -> { amount, date, description, direction, suggestedCategoryGuid }
 *
 * The model receives the active book's expense/income account list
 * (names + guids) and picks the best category; the returned guid is validated
 * against that same list server-side. Relative dates ("yesterday",
 * "last friday") are returned verbatim by the model and resolved here against
 * today's date (UTC). Falls back to 400 with a helpful message when no AI
 * provider is configured or the text can't be parsed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getAiConfig } from '@/lib/ai-config';
import { getBookAccountGuids } from '@/lib/book-scope';
import { chatComplete, extractJsonObject, isAiConfigured } from '@/lib/ai-query/client';
import {
    buildParseMessages,
    validateParsedTransaction,
    type CategoryAccount,
} from '@/lib/nl-parse';
import prisma from '@/lib/prisma';

const NOT_CONFIGURED_MESSAGE =
    'AI is not configured. Set up a provider under Settings → AI to use natural-language entry.';

const MAX_TEXT_LENGTH = 300;

export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { user } = roleResult;

        const config = await getAiConfig(user.id);
        return NextResponse.json({ configured: isAiConfigured(config) });
    } catch (error) {
        console.error('parse-transaction config check error:', error);
        return NextResponse.json({ configured: false });
    }
}

async function loadCategoryAccounts(): Promise<CategoryAccount[]> {
    const bookGuids = await getBookAccountGuids();
    if (bookGuids.length === 0) return [];

    const rows = await prisma.$queryRaw<Array<{
        guid: string;
        account_type: string;
        fullname: string | null;
        name: string;
    }>>`
        SELECT a.guid, a.account_type, ah.fullname, a.name
        FROM accounts a
        LEFT JOIN account_hierarchy ah ON ah.guid = a.guid
        WHERE a.guid = ANY(${bookGuids})
          AND a.account_type IN ('EXPENSE', 'INCOME')
          AND a.hidden = 0
          AND a.placeholder = 0
        ORDER BY a.account_type, ah.fullname NULLS LAST, a.name
    `;

    return rows.map(r => ({
        guid: r.guid,
        name: r.fullname || r.name,
        account_type: r.account_type,
    }));
}

export async function POST(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { user } = roleResult;

        const body = await request.json().catch(() => null);
        const text = typeof body?.text === 'string' ? body.text.trim() : '';
        if (!text) {
            return NextResponse.json({ error: 'text is required' }, { status: 400 });
        }
        if (text.length > MAX_TEXT_LENGTH) {
            return NextResponse.json(
                { error: `text is too long (max ${MAX_TEXT_LENGTH} characters)` },
                { status: 400 }
            );
        }

        const config = await getAiConfig(user.id);
        if (!isAiConfigured(config)) {
            return NextResponse.json({ error: NOT_CONFIGURED_MESSAGE }, { status: 400 });
        }

        const accounts = await loadCategoryAccounts();

        let raw: Record<string, unknown>;
        try {
            const reply = await chatComplete(config, buildParseMessages(text, accounts), {
                maxTokens: 400,
                timeoutMs: 30000,
            });
            raw = extractJsonObject(reply);
        } catch (err) {
            console.error('parse-transaction AI call failed:', err);
            const message = err instanceof Error && err.name === 'TimeoutError'
                ? 'The AI request timed out — try again.'
                : 'Could not parse that with the configured AI provider. Try again or enter the transaction manually.';
            return NextResponse.json({ error: message }, { status: 502 });
        }

        const result = validateParsedTransaction(raw, {
            accounts,
            today: new Date(),
            originalText: text,
        });
        if (!result.ok) {
            return NextResponse.json({ error: result.error }, { status: 400 });
        }

        return NextResponse.json(result.value);
    } catch (error) {
        console.error('parse-transaction error:', error);
        return NextResponse.json(
            { error: 'Failed to parse the transaction text' },
            { status: 500 }
        );
    }
}
