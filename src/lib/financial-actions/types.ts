export type FinancialActionLane = 'fix' | 'decide' | 'do';
export type FinancialActionState =
  | 'open'
  | 'snoozed'
  | 'accepted'
  | 'resolved'
  | 'dismissed'
  | 'expired';
export type FinancialActionSeverity = 'info' | 'warning' | 'critical';
export type FinancialActionOrigin =
  | 'transaction_review'
  | 'receipt_inbox'
  | 'statement_reconciliation'
  | 'data_health'
  | 'insight'
  | 'compliance'
  | 'business_close'
  | 'failed_job'
  | 'notification'
  | 'opportunity';

export type EvidenceKind =
  | 'account'
  | 'transaction'
  | 'split'
  | 'receipt'
  | 'statement'
  | 'payslip'
  | 'price'
  | 'fx_rate'
  | 'rule'
  | 'tax_table'
  | 'assumption'
  | 'report_query'
  | 'notification'
  | 'job';

export type EvidenceSource =
  | 'manual'
  | 'simplefin'
  | 'statement'
  | 'receipt'
  | 'payslip'
  | 'market_price'
  | 'system'
  | 'rule';

export interface EvidenceRef {
  kind: EvidenceKind;
  id: string;
  label: string;
  source: EvidenceSource;
  href?: string;
  observedAt?: string;
  verified?: boolean;
  stale?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CalculationStep {
  key: string;
  label: string;
  formula?: string;
  inputs: Record<string, number | string | boolean | null>;
  result: number | string | boolean | null;
}

export interface CalculationTrace {
  id: string;
  version: number;
  title: string;
  summary: string;
  generatedAt: string;
  asOfDate: string;
  formula?: string;
  result: number | string | boolean | null;
  unit?: 'currency' | 'percent' | 'count' | 'date' | 'text';
  range?: { low: number; high: number };
  steps: CalculationStep[];
  evidence: EvidenceRef[];
  assumptions: string[];
  warnings: string[];
  metadata?: Record<string, unknown>;
}

export interface TraceReference {
  traceId: string;
  href: string;
}

export interface FinancialActionOperation {
  id: string;
  label: string;
  kind: 'link' | 'state' | 'create_rule';
  href?: string;
  targetState?: FinancialActionState;
  primary?: boolean;
}

export interface OpportunityScore {
  total: number;
  afterTaxValue: number;
  urgency: number;
  confidence: number;
  liquidityCost: number;
  reversibility: number;
  goalAlignment: number;
}

export interface FinancialActionCandidate {
  stableKey: string;
  lane: FinancialActionLane;
  origin: FinancialActionOrigin;
  sourceId: string;
  severity: FinancialActionSeverity;
  title: string;
  summary: string;
  dueDate?: string | null;
  impact?: { low: number; high: number; period: 'one_time' | 'annual' | 'lifetime' } | null;
  confidence: number;
  score?: OpportunityScore | null;
  assignee?: string | null;
  operations: FinancialActionOperation[];
  trace: CalculationTrace;
  metadata?: Record<string, unknown>;
}

export interface FinancialAction extends FinancialActionCandidate {
  id: string;
  bookGuid: string;
  state: FinancialActionState;
  snoozedUntil: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  stateChangedAt: string;
  resolvedAt: string | null;
}

export interface FinancialActionWeeklySummary {
  new: number;
  resolved: number;
  automated: number;
  overdue: number;
}

export interface FinancialActionList {
  actions: FinancialAction[];
  summary: FinancialActionWeeklySummary;
  verifiedThrough: string | null;
  generatedAt: string;
}
