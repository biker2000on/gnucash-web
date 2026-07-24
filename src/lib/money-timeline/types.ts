import type { EvidenceRef } from '@/lib/financial-actions/types';

export const FINANCIAL_EVENT_DOMAINS = [
  'scheduled',
  'fixed_income',
  'rmd',
  'compliance',
  'renewal',
  'home',
  'invoice',
  'goal',
  'equity_comp',
  'report_schedule',
  'plan',
] as const;

export type FinancialEventDomain = (typeof FINANCIAL_EVENT_DOMAINS)[number];
export type FinancialEventStatus = 'expected' | 'needs_action' | 'overdue' | 'complete';

/**
 * Shared dated-obligation contract. Source adapters never mutate their source
 * record; this is a read model consumed by Timeline, plans, Action Center, and
 * iCal.
 */
export interface FinancialEvent {
  id: string;
  bookGuid: string;
  domain: FinancialEventDomain;
  title: string;
  description: string | null;
  date: string;
  endDate: string | null;
  /** Signed in the event book's base currency: inflow positive, outflow negative. */
  cashImpact: number | null;
  currency: string;
  confidence: number;
  status: FinancialEventStatus;
  href: string | null;
  sourceId: string;
  actionId: string | null;
  planId: string | null;
  evidence: EvidenceRef[];
  metadata: Record<string, unknown>;
}

export type TimelineConflictKind =
  | 'low_cash'
  | 'duplicate'
  | 'overdue'
  | 'contribution_window';

export interface TimelineConflict {
  id: string;
  kind: TimelineConflictKind;
  severity: 'info' | 'warning' | 'critical';
  date: string;
  title: string;
  description: string;
  eventIds: string[];
  projectedCash?: number;
}

export interface MoneyTimeline {
  generatedAt: string;
  from: string;
  to: string;
  currency: string;
  openingCash: number;
  events: FinancialEvent[];
  conflicts: TimelineConflict[];
  domains: Array<{ domain: FinancialEventDomain; count: number }>;
}
