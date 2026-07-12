// src/lib/ai-query/answer.ts

/**
 * Final answer composition: sends the query results back to the model for a
 * concise natural-language answer, plus optional drill-down links into the
 * ledger and specific account pages.
 */

import type { AiConfig } from '@/lib/receipt-extraction';
import { chatComplete, extractJsonObject, type AiChatMessage } from './client';
import type { QueryRow } from './execute';

export interface DrillDownLink {
    label: string;
    href: string;
}

export interface ComposedAnswer {
    answer: string;
    links: DrillDownLink[];
}

const MAX_ROWS_TO_MODEL = 50;
const GUID_RE = /^[0-9a-f]{32}$/i;

const ANSWER_SYSTEM_PROMPT = `You are a personal-finance assistant. You are given a user's question about their GnuCash books, the SQL that was run, and the resulting rows. Write a concise, direct answer.

Rules:
- 1-3 sentences. Lead with the number(s) the user asked for.
- Format currency like $1,234.56 (thousands separators, 2 decimals). Remember
  GnuCash sign conventions: income sums come back negative — present them as
  positive income. Expense sums are positive.
- If the result set is empty, say so plainly and suggest a likely reason.
- Never invent numbers that are not derivable from the rows.

Respond with ONLY a JSON object (no markdown fences):
{
  "answer": "<the answer text>",
  "ledger_search": "<a short search term for the transaction journal that would let the user see the underlying transactions, or null if not useful>",
  "accounts": [{"guid": "<32-char hex account guid taken from the rows>", "name": "<account name>"}]
}
"accounts": up to 3 accounts central to the answer — ONLY guids that literally appear in the result rows; otherwise [].`;

/** Fallback answer when the answer-composition call fails. */
function fallbackAnswer(rows: QueryRow[]): ComposedAnswer {
    const n = rows.length;
    return {
        answer: n === 0
            ? 'The query ran successfully but returned no rows.'
            : `The query returned ${n} row${n === 1 ? '' : 's'} — see the result table below.`,
        links: [],
    };
}

export async function composeAnswer(params: {
    question: string;
    sql: string;
    plan: string;
    rows: QueryRow[];
    config: AiConfig;
    /** Book scope — account links are only emitted for guids inside it. */
    accountGuids: string[];
}): Promise<ComposedAnswer> {
    const { question, sql, plan, rows, config, accountGuids } = params;

    const messages: AiChatMessage[] = [
        { role: 'system', content: ANSWER_SYSTEM_PROMPT },
        {
            role: 'user',
            content: JSON.stringify({
                question,
                plan,
                sql,
                row_count: rows.length,
                rows: rows.slice(0, MAX_ROWS_TO_MODEL),
                rows_truncated: rows.length > MAX_ROWS_TO_MODEL,
            }),
        },
    ];

    let parsed: Record<string, unknown>;
    try {
        const content = await chatComplete(config, messages, { maxTokens: 800, timeoutMs: 60000 });
        parsed = extractJsonObject(content);
    } catch {
        return fallbackAnswer(rows);
    }

    const answer = typeof parsed.answer === 'string' && parsed.answer.trim()
        ? parsed.answer.trim()
        : fallbackAnswer(rows).answer;

    const links: DrillDownLink[] = [];

    // Account drill-downs: validate shape, guid format, and book membership
    // so a confabulated guid can never become a link.
    const inBook = new Set(accountGuids.map(g => g.toLowerCase()));
    const seen = new Set<string>();
    if (Array.isArray(parsed.accounts)) {
        for (const item of parsed.accounts) {
            if (links.length >= 3) break;
            if (!item || typeof item !== 'object') continue;
            const acct = item as Record<string, unknown>;
            const guid = typeof acct.guid === 'string' ? acct.guid.toLowerCase() : '';
            if (!GUID_RE.test(guid) || !inBook.has(guid) || seen.has(guid)) continue;
            seen.add(guid);
            const name = typeof acct.name === 'string' && acct.name.trim() ? acct.name.trim() : 'Account';
            links.push({ label: name, href: `/accounts/${guid}` });
        }
    }

    if (typeof parsed.ledger_search === 'string' && parsed.ledger_search.trim()) {
        const term = parsed.ledger_search.trim().slice(0, 100);
        links.push({
            label: `Search ledger: "${term}"`,
            href: `/ledger?search=${encodeURIComponent(term)}`,
        });
    }

    return { answer, links };
}
