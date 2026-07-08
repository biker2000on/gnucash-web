import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { generateInvestmentPortfolio } from '@/lib/reports/investment-portfolio';
import { ToolConfigService } from '@/lib/services/tool-config.service';
import {
    computeRebalance,
    annotateSellSuggestions,
    loadSellCandidatesBySymbol,
    DEFAULT_BAND_PCT,
    type RebalanceHolding,
    type RebalanceTarget,
    type SellLotCandidate,
} from '@/lib/rebalancing';

const TOOL_TYPE = 'rebalance_targets';
const CONFIG_NAME = 'Rebalance Targets';

const SaveTargetsSchema = z.object({
    targets: z.array(
        z.object({
            key: z.string().min(1).max(64),
            targetPct: z.number().min(0).max(100),
        })
    ),
    bandPct: z.number().min(0).max(50).optional(),
});

interface SavedConfig {
    targets: RebalanceTarget[];
    bandPct: number;
}

function parseSavedConfig(config: unknown): SavedConfig {
    const fallback: SavedConfig = { targets: [], bandPct: DEFAULT_BAND_PCT };
    if (!config || typeof config !== 'object') return fallback;
    const obj = config as Record<string, unknown>;

    const targets: RebalanceTarget[] = [];
    if (Array.isArray(obj.targets)) {
        for (const t of obj.targets) {
            if (
                t && typeof t === 'object' &&
                typeof (t as Record<string, unknown>).key === 'string' &&
                typeof (t as Record<string, unknown>).targetPct === 'number'
            ) {
                targets.push({
                    key: (t as { key: string }).key,
                    targetPct: (t as { targetPct: number }).targetPct,
                });
            }
        }
    }

    const bandPct = typeof obj.bandPct === 'number' && obj.bandPct >= 0
        ? obj.bandPct
        : DEFAULT_BAND_PCT;

    return { targets, bandPct };
}

/**
 * GET /api/investments/rebalance
 *
 * Query params:
 *   - newCash: optional dollars of new cash to invest (buy-only mode)
 *   - band: optional tolerance band override (absolute percentage points)
 *   - targets: optional JSON array [{key,targetPct}] to preview unsaved
 *     targets; when omitted the saved targets are used
 *
 * Returns current holdings consolidated by symbol, the saved targets,
 * computed drift rows, and rebalancing suggestions with tax
 * annotations on sells.
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { user, bookGuid } = roleResult;

        const { searchParams } = new URL(request.url);
        const newCashRaw = parseFloat(searchParams.get('newCash') || '0');
        const newCash = Number.isFinite(newCashRaw) ? Math.max(0, newCashRaw) : 0;
        const bandRaw = searchParams.get('band');

        const bookAccountGuids = await getBookAccountGuids();

        // Current holdings via the existing portfolio report lib
        const portfolio = await generateInvestmentPortfolio(
            { startDate: null, endDate: null, bookAccountGuids },
            false
        );

        // Consolidate per-account holdings by symbol
        const bySymbol = new Map<string, {
            value: number;
            accounts: Array<{ guid: string; name?: string }>;
        }>();
        for (const h of portfolio.holdings) {
            const entry = bySymbol.get(h.symbol) ?? { value: 0, accounts: [] };
            entry.value += h.marketValue;
            entry.accounts.push({ guid: h.guid, name: h.accountName });
            bySymbol.set(h.symbol, entry);
        }

        // Commodity full names for labels
        const symbols = [...bySymbol.keys()];
        const commodities = symbols.length > 0
            ? await prisma.commodities.findMany({
                where: { mnemonic: { in: symbols }, namespace: { not: 'CURRENCY' } },
                select: { mnemonic: true, fullname: true },
            })
            : [];
        const nameMap = new Map(commodities.map(c => [c.mnemonic, c.fullname || c.mnemonic]));

        const holdings: RebalanceHolding[] = symbols.map(symbol => ({
            key: symbol,
            label: nameMap.get(symbol) || symbol,
            currentValue: Math.round(bySymbol.get(symbol)!.value * 100) / 100,
        }));

        // Saved targets from tool config
        const configs = await ToolConfigService.listByUser(user.id, bookGuid, TOOL_TYPE);
        const saved = parseSavedConfig(configs[0]?.config);

        // Optional unsaved-targets preview
        let effectiveTargets = saved.targets;
        const targetsParam = searchParams.get('targets');
        if (targetsParam) {
            try {
                const parsed: unknown = JSON.parse(targetsParam);
                if (Array.isArray(parsed)) {
                    effectiveTargets = parsed
                        .filter((t): t is { key: string; targetPct: number } =>
                            !!t && typeof t === 'object' &&
                            typeof (t as Record<string, unknown>).key === 'string' &&
                            typeof (t as Record<string, unknown>).targetPct === 'number' &&
                            Number.isFinite((t as { targetPct: number }).targetPct) &&
                            (t as { targetPct: number }).targetPct >= 0
                        )
                        .map(t => ({ key: t.key, targetPct: t.targetPct }));
                }
            } catch {
                // Malformed preview payload — fall back to saved targets
            }
        }

        const bandOverride = bandRaw !== null ? parseFloat(bandRaw) : NaN;
        const bandPct = Number.isFinite(bandOverride) && bandOverride >= 0
            ? bandOverride
            : saved.bandPct;

        const result = computeRebalance(holdings, effectiveTargets, { newCash, bandPct });

        // Tax-aware annotation for SELL suggestions
        const sellKeys = result.suggestions
            .filter(s => s.action === 'SELL')
            .map(s => s.key);
        if (sellKeys.length > 0) {
            const accountsBySymbol: Record<string, Array<{ guid: string; name?: string }>> = {};
            for (const key of sellKeys) {
                accountsBySymbol[key] = bySymbol.get(key)?.accounts ?? [];
            }
            const lotsByKey: Record<string, SellLotCandidate[]> =
                await loadSellCandidatesBySymbol(accountsBySymbol);
            result.suggestions = annotateSellSuggestions(result.suggestions, lotsByKey);
        }

        return NextResponse.json({
            ...result,
            holdings,
            savedTargets: saved.targets,
            savedBandPct: saved.bandPct,
            generatedAt: new Date().toISOString(),
        });
    } catch (error) {
        console.error('Rebalance API error:', error);
        return NextResponse.json(
            { error: 'Failed to compute rebalancing data' },
            { status: 500 }
        );
    }
}

/**
 * PUT /api/investments/rebalance
 *
 * Save target allocations (and optional band) to gnucash_web_tool_config.
 * Body: { targets: [{ key, targetPct }], bandPct?: number }
 */
export async function PUT(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { user, bookGuid } = roleResult;

        const body = await request.json();
        const validated = SaveTargetsSchema.parse(body);

        // Drop zero-percent targets — absence already means 0%
        const targets = validated.targets.filter(t => t.targetPct > 0);

        const config: Record<string, unknown> = {
            targets,
            bandPct: validated.bandPct ?? DEFAULT_BAND_PCT,
        };

        const existing = await ToolConfigService.listByUser(user.id, bookGuid, TOOL_TYPE);
        const savedRow = existing.length > 0
            ? await ToolConfigService.update(existing[0].id, user.id, bookGuid, { config })
            : await ToolConfigService.create(user.id, bookGuid, {
                toolType: TOOL_TYPE,
                name: CONFIG_NAME,
                config,
            });

        if (!savedRow) {
            return NextResponse.json({ error: 'Failed to save targets' }, { status: 500 });
        }

        return NextResponse.json({
            targets,
            bandPct: config.bandPct,
            savedAt: new Date().toISOString(),
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return NextResponse.json(
                { error: 'Invalid targets payload', details: error.issues },
                { status: 400 }
            );
        }
        console.error('Rebalance save error:', error);
        return NextResponse.json(
            { error: 'Failed to save rebalancing targets' },
            { status: 500 }
        );
    }
}
