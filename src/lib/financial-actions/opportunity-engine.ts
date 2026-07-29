import {
  createCalculationTrace,
} from '@/lib/provenance';
import type {
  EvidenceRef,
  FinancialActionCandidate,
  OpportunityScore,
} from './types';

export interface OpportunitySignal {
  key: string;
  title: string;
  summary: string;
  href: string;
  dueDate?: string;
  valueLow: number;
  valueHigh: number;
  impactPeriod: 'one_time' | 'annual' | 'lifetime';
  cashRequired: number;
  urgency: number;
  confidence: number;
  liquidityCost: number;
  reversibility: number;
  goalAlignment?: number;
  severity?: 'info' | 'warning' | 'critical';
  assumptions?: string[];
  evidence?: EvidenceRef[];
  metadata?: Record<string, unknown>;
}

export interface OpportunitySnapshot {
  asOfDate: string;
  estimatedTax?: OpportunitySignal | null;
  contributionCapacity?: OpportunitySignal[];
  debtPaydown?: OpportunitySignal | null;
  emergencyFund?: OpportunitySignal | null;
  portfolio?: OpportunitySignal[];
  taxStrategy?: OpportunitySignal[];
  subscriptions?: OpportunitySignal[];
  budgetGaps?: OpportunitySignal[];
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

export function scoreOpportunity(signal: OpportunitySignal): OpportunityScore {
  const afterTaxValue = Math.max(0, (signal.valueLow + signal.valueHigh) / 2);
  const valueScore = clamp(Math.log10(afterTaxValue + 1) * 20);
  const cashPenalty = signal.cashRequired <= 0
    ? 0
    : clamp(Math.log10(signal.cashRequired + 1) * 4);
  const total = clamp(
    valueScore * 0.32
      + clamp(signal.urgency) * 0.22
      + clamp(signal.confidence * 100) * 0.2
      + clamp(signal.reversibility) * 0.1
      + clamp(signal.goalAlignment ?? 50) * 0.1
      - clamp(signal.liquidityCost) * 0.06
      - cashPenalty,
  );

  return {
    total: Math.round(total * 10) / 10,
    afterTaxValue: Math.round(afterTaxValue * 100) / 100,
    urgency: clamp(signal.urgency),
    confidence: clamp(signal.confidence * 100),
    liquidityCost: clamp(signal.liquidityCost),
    reversibility: clamp(signal.reversibility),
    goalAlignment: clamp(signal.goalAlignment ?? 50),
  };
}

function signalToAction(
  pack: string,
  signal: OpportunitySignal,
  asOfDate: string,
): FinancialActionCandidate {
  const score = scoreOpportunity(signal);
  const trace = createCalculationTrace({
    namespace: `opportunity:${pack}`,
    identity: { pack, key: signal.key },
    title: `Why this opportunity is ranked ${Math.round(score.total)}/100`,
    summary: signal.summary,
    asOfDate,
    formula: 'rank = value + urgency + confidence + reversibility + goal alignment - liquidity cost',
    result: score.total,
    unit: 'count',
    range: { low: signal.valueLow, high: signal.valueHigh },
    steps: [
      {
        key: 'estimated-value',
        label: 'Estimated after-tax value',
        formula: '(low estimate + high estimate) / 2',
        inputs: { low: signal.valueLow, high: signal.valueHigh },
        result: score.afterTaxValue,
      },
      {
        key: 'ranking',
        label: 'Priority score',
        inputs: {
          urgency: score.urgency,
          confidence: score.confidence,
          liquidityCost: score.liquidityCost,
          reversibility: score.reversibility,
          goalAlignment: score.goalAlignment,
        },
        result: score.total,
      },
    ],
    evidence: signal.evidence,
    assumptions: signal.assumptions,
    metadata: {
      pack,
      cashRequired: signal.cashRequired,
      ...signal.metadata,
    },
  });

  return {
    stableKey: `opportunity:${pack}:${signal.key}`,
    lane: 'decide',
    origin: 'opportunity',
    sourceId: `${pack}:${signal.key}`,
    severity: signal.severity ?? (signal.urgency >= 80 ? 'warning' : 'info'),
    title: signal.title,
    summary: signal.summary,
    dueDate: signal.dueDate ?? null,
    impact: {
      low: signal.valueLow,
      high: signal.valueHigh,
      period: signal.impactPeriod,
    },
    confidence: signal.confidence,
    score,
    operations: [
      { id: 'review', label: 'Review plan', kind: 'link', href: signal.href, primary: true },
      {
        id: 'plan-impact',
        label: 'Plan impact',
        kind: 'link',
        href: `/planning/plan?opportunity=${encodeURIComponent(`${pack}:${signal.key}`)}`,
      },
      { id: 'accept', label: 'Accept', kind: 'state', targetState: 'accepted' },
      { id: 'dismiss', label: 'Dismiss', kind: 'state', targetState: 'dismissed' },
    ],
    trace,
    metadata: {
      opportunityPack: pack,
      cashRequired: signal.cashRequired,
      tradeoffs: signal.assumptions ?? [],
      ...signal.metadata,
    },
  };
}

function pack(
  name: string,
  signals: OpportunitySignal[] | OpportunitySignal | null | undefined,
  asOfDate: string,
): FinancialActionCandidate[] {
  if (!signals) return [];
  return (Array.isArray(signals) ? signals : [signals])
    .filter(signal =>
      signal.confidence >= 0.65
      && signal.valueHigh > 0
      && signal.valueHigh >= signal.valueLow,
    )
    .map(signal => signalToAction(name, signal, asOfDate));
}

/**
 * Eight deterministic opportunity packs. Inputs are deliberately normalized:
 * loaders may evolve, while ranking and behavior remain inspectable and easy
 * to test without a database or an AI model.
 */
export function detectOpportunities(snapshot: OpportunitySnapshot): FinancialActionCandidate[] {
  return [
    ...pack('estimated-tax', snapshot.estimatedTax, snapshot.asOfDate),
    ...pack('contribution-capacity', snapshot.contributionCapacity, snapshot.asOfDate),
    ...pack('debt-vs-cash', snapshot.debtPaydown, snapshot.asOfDate),
    ...pack('emergency-fund', snapshot.emergencyFund, snapshot.asOfDate),
    ...pack('portfolio', snapshot.portfolio, snapshot.asOfDate),
    ...pack('tax-strategy', snapshot.taxStrategy, snapshot.asOfDate),
    ...pack('subscriptions', snapshot.subscriptions, snapshot.asOfDate),
    ...pack('budget-gaps', snapshot.budgetGaps, snapshot.asOfDate),
  ].sort((a, b) =>
    (b.score?.total ?? 0) - (a.score?.total ?? 0)
    || (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31')
    || a.stableKey.localeCompare(b.stableKey),
  );
}
