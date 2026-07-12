// src/lib/ai-query/client.ts

/**
 * Thin chat-completion client for the "Ask your books" feature.
 *
 * Reuses the app's existing AI provider abstraction: the AiConfig shape from
 * '@/lib/receipt-extraction' (provider / base_url / api_key / model / enabled,
 * resolved per-user by getAiConfig() in '@/lib/ai-config') and the same
 * OpenAI-compatible POST {base_url}/chat/completions pattern used by the
 * receipt, payslip, and statement extraction pipelines.
 */

import type { AiConfig } from '@/lib/receipt-extraction';

export interface AiChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/** Same configured-check used by the extraction routes. */
export function isAiConfigured(config: AiConfig | null): config is AiConfig {
    return !!config && config.enabled && !!config.base_url && !!config.model;
}

/** POST a chat completion to the configured OpenAI-compatible provider. */
export async function chatComplete(
    config: AiConfig,
    messages: AiChatMessage[],
    opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<string> {
    const url = `${config.base_url!.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.api_key) headers['Authorization'] = `Bearer ${config.api_key}`;

    const response = await fetch(url, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60000),
        body: JSON.stringify({
            model: config.model,
            messages,
            temperature: 0,
            max_tokens: opts.maxTokens ?? 1500,
        }),
    });

    if (!response.ok) {
        throw new Error(`AI API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') {
        throw new Error('Empty AI response');
    }
    return content;
}

/**
 * Parse a JSON object out of a model reply, tolerating markdown fences and
 * surrounding prose (same tolerance as the statement-extraction parser).
 */
export function extractJsonObject(raw: string): Record<string, unknown> {
    let jsonStr = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();

    if (!jsonStr.startsWith('{')) {
        const first = jsonStr.indexOf('{');
        const last = jsonStr.lastIndexOf('}');
        if (first !== -1 && last > first) jsonStr = jsonStr.slice(first, last + 1);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonStr);
    } catch {
        throw new Error(`AI response was not valid JSON: ${raw.slice(0, 120)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('AI response was not a JSON object');
    }
    return parsed as Record<string, unknown>;
}
