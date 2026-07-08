'use client';

import { formatCurrency } from '@/lib/format';
import type { WithholdingCheckup } from '@/lib/withholding';

const MONO = { fontFeatureSettings: "'tnum'" } as const;

/** One line in the projection breakdown. */
function BreakdownRow({
  label,
  value,
  sub,
  tone,
  strong,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'positive' | 'negative' | 'neutral';
  strong?: boolean;
}) {
  const valueClass =
    tone === 'positive' ? 'text-positive' : tone === 'negative' ? 'text-negative' : 'text-foreground';
  return (
    <div
      className={`flex items-baseline justify-between gap-3 py-2 ${strong ? 'border-t border-border' : ''}`}
    >
      <div>
        <p className={`text-sm ${strong ? 'font-semibold text-foreground' : 'text-foreground-secondary'}`}>
          {label}
        </p>
        {sub && <p className="text-[11px] text-foreground-muted mt-0.5">{sub}</p>}
      </div>
      <p
        className={`font-mono text-sm ${strong ? 'font-semibold' : ''} ${valueClass} whitespace-nowrap`}
        style={MONO}
      >
        {value}
      </p>
    </div>
  );
}

/**
 * Headline verdict + the projected income → liability → withholding → gap
 * breakdown. The verdict reads green when on track (refund / meets safe
 * harbor) and red when under-withheld.
 */
export default function WithholdingHeadline({ checkup }: { checkup: WithholdingCheckup }) {
  const onTrack = !checkup.underWithheld;
  const verdictTone = onTrack ? 'positive' : 'negative';
  const balance = checkup.projectedBalance;

  const headline = onTrack
    ? checkup.status === 'refund'
      ? `On track — projected refund of ${formatCurrency(Math.abs(balance))}`
      : 'On track — withholding roughly matches your projected tax'
    : `Under-withheld by ${formatCurrency(Math.abs(balance))}`;

  const safeHarborNote = checkup.meetsSafeHarbor
    ? 'Meets the IRS safe harbor — no underpayment penalty expected.'
    : `Below the safe harbor by ${formatCurrency(checkup.gapToSafeHarbor)} (${checkup.safeHarborBasis}).`;

  return (
    <div className="space-y-4">
      {/* Verdict banner */}
      <div
        className={`rounded-lg border p-5 ${
          onTrack ? 'border-positive/30 bg-positive/5' : 'border-negative/30 bg-negative/5'
        }`}
      >
        <p className="text-xs uppercase tracking-wide text-foreground-muted">
          {checkup.status === 'owe' ? 'Projected balance due' : 'Projected outcome'}
        </p>
        <p
          className={`mt-1 text-2xl font-bold font-mono ${
            verdictTone === 'positive' ? 'text-positive' : 'text-negative'
          }`}
          style={MONO}
        >
          {headline}
        </p>
        <p className="mt-2 text-xs text-foreground-secondary">{safeHarborNote}</p>
      </div>

      {/* Projection breakdown */}
      <div className="rounded-lg border border-border bg-surface p-5">
        <BreakdownRow
          label="Projected income (AGI)"
          value={formatCurrency(checkup.projectedAgi)}
          sub={checkup.annualized ? 'Annualized from year-to-date' : 'Year totals'}
        />
        <BreakdownRow
          label="Projected federal liability"
          value={formatCurrency(checkup.projectedLiability)}
          tone="negative"
          sub={`Marginal ${(checkup.federal.marginalRate * 100).toFixed(0)}% · effective ${(checkup.federal.effectiveRate * 100).toFixed(1)}%`}
        />
        <BreakdownRow
          label="Projected withholding"
          value={formatCurrency(checkup.projectedWithholding)}
          sub={`Year-to-date ${formatCurrency(checkup.ytdWithholding)}${
            checkup.ytdEstimatedPayments > 0.005
              ? ` + ${formatCurrency(checkup.ytdEstimatedPayments)} estimated`
              : ''
          }`}
        />
        <BreakdownRow
          label={balance >= 0 ? 'Projected refund' : 'Projected balance due'}
          value={formatCurrency(Math.abs(balance))}
          tone={balance >= 0 ? 'positive' : 'negative'}
          strong
        />
      </div>
    </div>
  );
}
