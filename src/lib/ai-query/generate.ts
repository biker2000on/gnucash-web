// src/lib/ai-query/generate.ts

/**
 * SQL generation: turns a natural-language question about the user's books
 * into a single guard-railed SELECT statement plus a short answer plan.
 */

import type { AiConfig } from '@/lib/receipt-extraction';
import { chatComplete, extractJsonObject, type AiChatMessage } from './client';
import { SCHEMA_CONTEXT } from './schema-context';
import { MAX_LIMIT } from './guardrails';

export interface ChatTurn {
    role: 'user' | 'assistant';
    content: string;
}

export interface GeneratedQuery {
    /** The generated SELECT statement (still must pass validateGeneratedSql). */
    sql: string;
    /** Short natural-language plan describing how the query answers the question. */
    plan: string;
}

const SYSTEM_PROMPT = `You are a SQL analyst for a personal-finance app backed by a GnuCash PostgreSQL database. Given a user question, write ONE PostgreSQL SELECT statement that answers it.

${SCHEMA_CONTEXT}

STRICT OUTPUT RULES:
- PostgreSQL dialect only.
- Produce exactly ONE statement: a single SELECT, optionally preceded by WITH
  (read-only CTEs only). No INSERT/UPDATE/DELETE/DDL of any kind, no
  data-modifying CTEs, no semicolons, no comments.
- ALWAYS aggregate money as value_num::numeric / value_denom (fractions).
- ALWAYS restrict account-joined data with the book-scope parameter:
  splits with s.account_guid = ANY($1), accounts/account_hierarchy with
  guid = ANY($1). $1 is the only parameter available.
- ALWAYS end the outer query with LIMIT ${MAX_LIMIT} or less.
- Round money to 2 decimals with ROUND(..., 2) and use clear column aliases.

Respond with ONLY a JSON object (no markdown fences, no commentary):
{"sql": "<the SELECT statement>", "plan": "<one or two sentences describing what the query computes and how you will phrase the answer>"}`;

/**
 * Ask the configured provider for a SQL statement + answer plan.
 *
 * @param feedback when a previous attempt failed guardrail validation, pass it
 *   back so the model can correct itself.
 */
export async function generateQuery(
    question: string,
    history: ChatTurn[],
    config: AiConfig,
    feedback?: { rejectedSql: string; reason: string },
): Promise<GeneratedQuery> {
    const messages: AiChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];

    // Prior conversation gives the model context for follow-up questions
    // ("what about Q2?"). Keep it short — the answers, not the row dumps.
    for (const turn of history.slice(-8)) {
        messages.push({ role: turn.role, content: turn.content.slice(0, 1000) });
    }

    messages.push({ role: 'user', content: question });

    if (feedback) {
        messages.push({ role: 'assistant', content: JSON.stringify({ sql: feedback.rejectedSql }) });
        messages.push({
            role: 'user',
            content: `That SQL was rejected by the safety validator: ${feedback.reason}. Produce a corrected statement that follows every rule, as the same JSON format.`,
        });
    }

    const content = await chatComplete(config, messages, { maxTokens: 1200, timeoutMs: 60000 });
    const parsed = extractJsonObject(content);

    const sql = typeof parsed.sql === 'string' ? parsed.sql.trim() : '';
    if (!sql) throw new Error('AI did not return a SQL statement');

    return {
        sql,
        plan: typeof parsed.plan === 'string' ? parsed.plan.trim() : '',
    };
}
