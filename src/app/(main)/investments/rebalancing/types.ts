import type {
    RebalanceHolding,
    RebalanceRow,
    RebalanceSuggestion,
    RebalanceTarget,
} from '@/lib/rebalancing';

/** Response shape of GET /api/investments/rebalance */
export interface RebalanceData {
    totalValue: number;
    targetBase: number;
    newCash: number;
    bandPct: number;
    mode: 'buy-only' | 'full';
    rows: RebalanceRow[];
    suggestions: RebalanceSuggestion[];
    warnings: string[];
    holdings: RebalanceHolding[];
    savedTargets: RebalanceTarget[];
    savedBandPct: number;
    generatedAt: string;
}
