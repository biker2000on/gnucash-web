/**
 * AI narrative for the monthly digest.
 *
 * Builds a compact JSON summary of an assembled MonthlyDigest (net-worth
 * change, cash flow, top category deltas, subscription changes, budget
 * status) and asks the configured chat model for a short factual narrative.
 * Returns { narrative } or null on ANY failure — callers treat the narrative
 * as strictly optional and never let it block digest generation.
 *
 * Pure pieces (payload/message builders, reply validation) are exported for
 * unit tests in src/lib/__tests__/digest-narrative.test.ts.
 */

import type { MonthlyDigest } from '@/lib/digest';
import type { AiChatMessage } from '@/lib/ai-query/client';
import { chatComplete } from '@/lib/ai-query/client';
import type { AiConfig } from '@/lib/receipt-extraction';

/** Chat function the narrative generator runs on (injectable for tests). */
export type NarrativeAiClient = (messages: AiChatMessage[]) => Promise<string>;

/** Caps keeping the prompt payload compact. */
export const MAX_NARRATIVE_CATEGORIES = 5;
export const MAX_NARRATIVE_SUBSCRIPTIONS = 3;
/** Upper bound on the accepted narrative length (characters). */
export const MAX_NARRATIVE_LENGTH = 1200;

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

export interface NarrativePayload {
    month: string;
    currency: string;
    netWorth: { end: number; change: number; changePercent: number };
    cashFlow: { income: number; expenses: number; savingsRate: number };
    topCategories: Array<{ name: string; amount: number; delta: number; percent: number }>;
    subscriptions: {
        new: Array<{ label: string; amount: number }>;
        changed: Array<{ label: string; amount: number; changePercent: number }>;
        stopped: Array<{ label: string; amount: number }>;
    };
    budget: {
        name: string;
        overCount: number;
        underCount: number;
        totalBudgeted: number;
        totalActual: number;
    } | null;
}

/**
 * Reduce a full digest to the compact JSON summary the model sees. Pure.
 * Category and subscription lists are capped so the payload stays small.
 */
export function buildNarrativePayload(digest: MonthlyDigest): NarrativePayload {
    return {
        month: digest.monthLabel,
        currency: digest.currency,
        netWorth: {
            end: round2(digest.netWorth.end),
            change: round2(digest.netWorth.change),
            changePercent: round2(digest.netWorth.changePercent),
        },
        cashFlow: {
            income: round2(digest.cashFlow.income),
            expenses: round2(digest.cashFlow.expenses),
            savingsRate: round2(digest.cashFlow.savingsRate),
        },
        topCategories: digest.topCategories.slice(0, MAX_NARRATIVE_CATEGORIES).map(c => ({
            name: c.name.slice(0, 60),
            amount: round2(c.amount),
            delta: round2(c.delta),
            percent: round2(c.percent),
        })),
        subscriptions: {
            new: digest.subscriptions.new.slice(0, MAX_NARRATIVE_SUBSCRIPTIONS).map(s => ({
                label: s.label.slice(0, 60),
                amount: round2(s.currentAmount),
            })),
            changed: digest.subscriptions.changed.slice(0, MAX_NARRATIVE_SUBSCRIPTIONS).map(s => ({
                label: s.label.slice(0, 60),
                amount: round2(s.currentAmount),
                changePercent: round2(s.changePercent),
            })),
            stopped: digest.subscriptions.stopped.slice(0, MAX_NARRATIVE_SUBSCRIPTIONS).map(s => ({
                label: s.label.slice(0, 60),
                amount: round2(s.currentAmount),
            })),
        },
        budget: digest.budget
            ? {
                name: digest.budget.budgetName.slice(0, 60),
                overCount: digest.budget.rows.filter(r => r.status === 'over').length,
                underCount: digest.budget.rows.filter(r => r.status === 'under').length,
                totalBudgeted: round2(digest.budget.totalBudgeted),
                totalActual: round2(digest.budget.totalActual),
            }
            : null,
    };
}

/** Build the chat messages for the narrative call. Pure. */
export function buildNarrativeMessages(digest: MonthlyDigest): AiChatMessage[] {
    const payload = buildNarrativePayload(digest);
    const system = [
        'You write a short narrative summary of a personal monthly financial digest.',
        'Rules:',
        '- 3 to 5 sentences, plain prose, no markdown, no bullet points.',
        '- Strictly factual: every number must come from the provided data. Do not invent figures.',
        '- No advice, no hype, no exclamation marks, no second-person coaching ("you should...").',
        '- Mention the net worth change, the cash-flow picture, and the most notable category or subscription movement.',
        `- Amounts are in ${payload.currency}.`,
    ].join('\n');

    return [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(payload) },
    ];
}

/**
 * Validate/normalize a model reply into a usable narrative string.
 * Returns null when the reply is empty, JSON-ish, or absurdly long. Pure.
 */
export function sanitizeNarrative(raw: string): string | null {
    if (typeof raw !== 'string') return null;
    const text = raw
        .replace(/^```[a-z]*\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();
    if (!text) return null;
    // A JSON blob or markdown heading means the model ignored instructions.
    if (text.startsWith('{') || text.startsWith('[') || text.startsWith('#')) return null;
    if (text.length > MAX_NARRATIVE_LENGTH) return text.slice(0, MAX_NARRATIVE_LENGTH).trim();
    return text;
}

/**
 * Generate the digest narrative via the provided chat client.
 * Returns { narrative } on success, null on ANY failure (bad reply, network
 * error, timeout) — never throws.
 */
export async function generateDigestNarrative(
    digestData: MonthlyDigest,
    aiClient: NarrativeAiClient
): Promise<{ narrative: string } | null> {
    try {
        const reply = await aiClient(buildNarrativeMessages(digestData));
        const narrative = sanitizeNarrative(reply);
        return narrative ? { narrative } : null;
    } catch {
        return null;
    }
}

/** Adapt an AiConfig into the NarrativeAiClient shape (bounded timeout). */
export function narrativeClientFor(config: AiConfig): NarrativeAiClient {
    return messages => chatComplete(config, messages, { maxTokens: 500, timeoutMs: 20000 });
}
