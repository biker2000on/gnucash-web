import type {
    RebalanceHolding,
    RebalanceRow,
    RebalanceSuggestion,
    RebalanceTarget,
} from '@/lib/rebalancing';
import type { RebalanceMode, SectorSuggestionGroup } from '@/lib/rebalancing-sector';

/** Response shape of GET /api/investments/rebalance */
export interface RebalanceData {
    totalValue: number;
    targetBase: number;
    newCash: number;
    bandPct: number;
    mode: 'buy-only' | 'full';
    /** Allocation keying the response was computed with. */
    allocationMode: RebalanceMode;
    /** Symbol rows in symbol mode; sector rows in sector mode. */
    rows: RebalanceRow[];
    /** Symbol-keyed in symbol mode; sector-keyed in sector mode. */
    suggestions: RebalanceSuggestion[];
    warnings: string[];
    /** Always symbol-keyed holdings. */
    holdings: RebalanceHolding[];
    /** Sector mode only: per-sector suggestion groups with symbol trades. */
    sectorGroups?: SectorSuggestionGroup[];
    /** Sector mode only: netted per-symbol trades with tax annotations. */
    symbolTrades?: RebalanceSuggestion[];
    /** Sector mode only: held symbols with no sector metadata. */
    unclassifiedSymbols?: string[];
    savedMode: RebalanceMode;
    /** Saved targets for the active allocation mode. */
    savedTargets: RebalanceTarget[];
    savedTargetsBySymbol: RebalanceTarget[];
    savedTargetsBySector: RebalanceTarget[];
    savedBandPct: number;
    generatedAt: string;
}
