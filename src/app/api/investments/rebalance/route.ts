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
import {
    holdingsToSectorExposure,
    mapSectorSuggestionsToSymbolTrades,
    parseRebalanceConfig,
    type RebalanceMode,
    type SectorMetadataEntry,
} from '@/lib/rebalancing-sector';

const TOOL_TYPE = 'rebalance_targets';
const CONFIG_NAME = 'Rebalance Targets';

const SaveTargetsSchema = z.object({
    mode: z.enum(['symbol', 'sector']).optional(),
    targets: z.array(
        z.object({
            key: z.string().min(1).max(64),
            targetPct: z.number().min(0).max(100),
        })
    ),
    bandPct: z.number().min(0).max(50).optional(),
});

function parseTargetsParam(raw: string | null): RebalanceTarget[] | null {
    if (!raw) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        return parsed
            .filter((t): t is { key: string; targetPct: number } =>
                !!t && typeof t === 'object' &&
                typeof (t as Record<string, unknown>).key === 'string' &&
                typeof (t as Record<string, unknown>).targetPct === 'number' &&
                Number.isFinite((t as { targetPct: number }).targetPct) &&
                (t as { targetPct: number }).targetPct >= 0
            )
            .map(t => ({ key: t.key, targetPct: t.targetPct }));
    } catch {
        return null; // Malformed preview payload — fall back to saved targets
    }
}

/** Load sector/sector-weight metadata for the given symbols, keyed by symbol. */
async function loadSectorMetadata(
    symbols: string[]
): Promise<Record<string, SectorMetadataEntry>> {
    if (symbols.length === 0) return {};
    const rows = await prisma.gnucash_web_commodity_metadata.findMany({
        where: { mnemonic: { in: symbols } },
        select: { mnemonic: true, sector: true, sector_weights: true },
    });
    const map: Record<string, SectorMetadataEntry> = {};
    for (const row of rows) {
        map[row.mnemonic] = {
            sector: row.sector,
            sectorWeights: row.sector_weights as Record<string, number> | null,
        };
    }
    return map;
}

/**
 * GET /api/investments/rebalance
 *
 * Query params:
 *   - mode: 'symbol' (default: saved mode) or 'sector'
 *   - newCash: optional dollars of new cash to invest (buy-only mode)
 *   - band: optional tolerance band override (absolute percentage points)
 *   - targets: optional JSON array [{key,targetPct}] to preview unsaved
 *     targets for the active mode; when omitted the saved targets are used
 *
 * Symbol mode: holdings and suggestions are keyed by commodity symbol.
 * Sector mode: holdings are spread into sector exposure using cached
 * commodity metadata (single stocks -> their sector, funds/ETFs ->
 * proportional sector_weights, unknown -> 'Unclassified'); rows and
 * suggestions are keyed by sector, and each sector trade is broken
 * down into per-symbol trades (sectorGroups) plus a netted per-symbol
 * list (symbolTrades) carrying the usual tax annotations on sells.
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

        // Saved targets from tool config (legacy shape migrates to symbol mode)
        const configs = await ToolConfigService.listByUser(user.id, bookGuid, TOOL_TYPE);
        const saved = parseRebalanceConfig(configs[0]?.config);

        const modeParam = searchParams.get('mode');
        const allocationMode: RebalanceMode = modeParam === 'sector' || modeParam === 'symbol'
            ? modeParam
            : saved.mode;

        const savedTargets = allocationMode === 'sector'
            ? saved.targetsBySector
            : saved.targetsBySymbol;

        // Optional unsaved-targets preview (applies to the active mode)
        const previewTargets = parseTargetsParam(searchParams.get('targets'));
        const effectiveTargets = previewTargets ?? savedTargets;

        const bandOverride = bandRaw !== null ? parseFloat(bandRaw) : NaN;
        const bandPct = Number.isFinite(bandOverride) && bandOverride >= 0
            ? bandOverride
            : saved.bandPct;

        if (allocationMode === 'sector') {
            // Spread symbol holdings into sector exposure
            const metadata = await loadSectorMetadata(symbols);
            const exposure = holdingsToSectorExposure(holdings, metadata);

            const result = computeRebalance(exposure.holdings, effectiveTargets, {
                newCash,
                bandPct,
            });

            // Map sector deltas to per-symbol trades and tax-annotate net sells
            const mapping = mapSectorSuggestionsToSymbolTrades(
                result.suggestions,
                exposure.contributions
            );
            const sellKeys = mapping.netBySymbol
                .filter(s => s.action === 'SELL')
                .map(s => s.key);
            if (sellKeys.length > 0) {
                const accountsBySymbol: Record<string, Array<{ guid: string; name?: string }>> = {};
                for (const key of sellKeys) {
                    accountsBySymbol[key] = bySymbol.get(key)?.accounts ?? [];
                }
                const lotsByKey: Record<string, SellLotCandidate[]> =
                    await loadSellCandidatesBySymbol(accountsBySymbol);
                mapping.netBySymbol = annotateSellSuggestions(mapping.netBySymbol, lotsByKey);
            }

            return NextResponse.json({
                ...result,
                allocationMode,
                holdings,
                sectorGroups: mapping.bySector,
                symbolTrades: mapping.netBySymbol,
                unclassifiedSymbols: exposure.unclassifiedSymbols,
                savedMode: saved.mode,
                savedTargets,
                savedTargetsBySymbol: saved.targetsBySymbol,
                savedTargetsBySector: saved.targetsBySector,
                savedBandPct: saved.bandPct,
                generatedAt: new Date().toISOString(),
            });
        }

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
            allocationMode,
            holdings,
            savedMode: saved.mode,
            savedTargets,
            savedTargetsBySymbol: saved.targetsBySymbol,
            savedTargetsBySector: saved.targetsBySector,
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
 * Body: { mode?: 'symbol'|'sector', targets: [{ key, targetPct }], bandPct?: number }
 *
 * Targets are stored per mode: saving in sector mode replaces
 * targetsBySector and leaves targetsBySymbol untouched (and vice
 * versa). The saved `mode` becomes the default for future GETs. Writes
 * always use the current shape
 * { mode, targetsBySymbol, targetsBySector, bandPct }; a legacy
 * { targets, bandPct } row is migrated on first save.
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

        const existing = await ToolConfigService.listByUser(user.id, bookGuid, TOOL_TYPE);
        const prior = parseRebalanceConfig(existing[0]?.config);

        const mode = validated.mode ?? prior.mode;
        const config: Record<string, unknown> = {
            mode,
            targetsBySymbol: mode === 'symbol' ? targets : prior.targetsBySymbol,
            targetsBySector: mode === 'sector' ? targets : prior.targetsBySector,
            bandPct: validated.bandPct ?? DEFAULT_BAND_PCT,
        };

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
            mode,
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
