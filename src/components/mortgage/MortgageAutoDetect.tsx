'use client';

import { useState, useCallback } from 'react';
import { AccountSelector } from '@/components/ui/AccountSelector';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface DetectionResult {
  originalAmount: number;
  interestRate: number;
  monthlyPayment: number;
  loanTermMonths?: number;
  paymentsAnalyzed: number;
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
}

export interface AutoDetectResult {
  originalAmount: number;
  interestRate: number;
  monthlyPayment: number;
  loanTermMonths: number;
  accountGuid: string;
  interestAccountGuid: string;
}

interface MortgageAutoDetectProps {
  onDetectionComplete: (result: AutoDetectResult) => void;
}

/* ------------------------------------------------------------------ */
/* Formatter                                                           */
/* ------------------------------------------------------------------ */

const fmtFull = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/* ------------------------------------------------------------------ */
/* Editable Value Field                                                */
/* ------------------------------------------------------------------ */

function EditableValue({
  label,
  value,
  onChange,
  format,
  suffix,
  ariaLabel,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  suffix?: string;
  ariaLabel: string;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  if (editing) {
    return (
      <div>
        <p className="text-xs text-foreground-muted mb-1">{label}</p>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const parsed = parseFloat(editValue);
                if (!isNaN(parsed)) onChange(parsed);
                setEditing(false);
              }
              if (e.key === 'Escape') setEditing(false);
            }}
            className="w-32 bg-input-bg border border-border rounded-lg py-1.5 px-3 text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
            aria-label={ariaLabel}
            autoFocus
          />
          {suffix && <span className="text-xs text-foreground-muted">{suffix}</span>}
          <button
            type="button"
            onClick={() => {
              const parsed = parseFloat(editValue);
              if (!isNaN(parsed)) onChange(parsed);
              setEditing(false);
            }}
            className="text-xs text-cyan-400 hover:text-cyan-300"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-xs text-foreground-muted hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs text-foreground-muted mb-1">{label}</p>
      <div className="flex items-center gap-2">
        <span className="text-emerald-400">
          <svg className="w-4 h-4 inline-block mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </span>
        <span className="text-lg font-semibold text-foreground tabular-nums">{format(value)}</span>
        <button
          type="button"
          onClick={() => {
            setEditValue(String(value));
            setEditing(true);
          }}
          className="text-xs text-foreground-muted hover:text-cyan-400 transition-colors"
          title="Edit value"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Skeleton loading cards                                              */
/* ------------------------------------------------------------------ */

function DetectionSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-5 h-5 rounded-full bg-cyan-500/20 animate-pulse" />
        <p className="text-sm text-foreground-muted">Analyzing payments...</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="bg-surface/30 border border-border rounded-xl p-4 space-y-2">
            <div className="h-3 w-24 bg-foreground-muted/20 rounded animate-pulse" />
            <div className="h-6 w-32 bg-foreground-muted/10 rounded animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function MortgageAutoDetect({ onDetectionComplete }: MortgageAutoDetectProps) {
  const [accountGuid, setAccountGuid] = useState('');
  const [interestAccountGuid, setInterestAccountGuid] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DetectionResult | null>(null);

  // Overridable values
  const [overrideOriginalAmount, setOverrideOriginalAmount] = useState<number | null>(null);
  const [overrideInterestRate, setOverrideInterestRate] = useState<number | null>(null);
  const [overrideMonthlyPayment, setOverrideMonthlyPayment] = useState<number | null>(null);
  const [overrideLoanTermMonths, setOverrideLoanTermMonths] = useState<number | null>(null);

  const runDetection = useCallback(async () => {
    if (!accountGuid || !interestAccountGuid) return;

    setLoading(true);
    setError(null);
    setResult(null);
    setOverrideOriginalAmount(null);
    setOverrideInterestRate(null);
    setOverrideMonthlyPayment(null);
    setOverrideLoanTermMonths(null);

    try {
      const res = await fetch(
        `/api/tools/mortgage/detect?accountGuid=${accountGuid}&interestAccountGuid=${interestAccountGuid}`
      );

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to detect mortgage details');
      }

      const data: DetectionResult = await res.json();
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to detect mortgage details');
    } finally {
      setLoading(false);
    }
  }, [accountGuid, interestAccountGuid]);

  // Auto-trigger detection when both accounts are selected
  const handleInterestAccountChange = useCallback(
    (guid: string) => {
      setInterestAccountGuid(guid);
      if (accountGuid && guid) {
        // Defer to next tick so state is updated
        setTimeout(() => {
          setLoading(true);
          setError(null);
          setResult(null);
          fetch(
            `/api/tools/mortgage/detect?accountGuid=${accountGuid}&interestAccountGuid=${guid}`
          )
            .then(async res => {
              if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || 'Failed to detect mortgage details');
              }
              return res.json();
            })
            .then((data: DetectionResult) => setResult(data))
            .catch(err => setError(err instanceof Error ? err.message : 'Failed to detect mortgage details'))
            .finally(() => setLoading(false));
        }, 0);
      }
    },
    [accountGuid],
  );

  const handleUseValues = () => {
    if (!result) return;

    const origAmount = overrideOriginalAmount ?? result.originalAmount;
    const rate = overrideInterestRate ?? result.interestRate;
    const payment = overrideMonthlyPayment ?? result.monthlyPayment;
    // Estimate term from original amount, rate, and payment if not provided
    const termMonths = overrideLoanTermMonths ?? result.loanTermMonths ?? estimateTerm(origAmount, rate, payment);

    onDetectionComplete({
      originalAmount: origAmount,
      interestRate: rate,
      monthlyPayment: payment,
      loanTermMonths: termMonths,
      accountGuid,
      interestAccountGuid,
    });
  };

  return (
    <div className="space-y-5">
      {/* Account selectors */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-foreground-muted mb-1">
            Mortgage Account (Liability)
          </label>
          <AccountSelector
            accountTypes={['LIABILITY']}
            value={accountGuid}
            onChange={(guid) => {
              setAccountGuid(guid);
              // Reset detection when account changes
              setResult(null);
              setError(null);
            }}
            placeholder="Select mortgage account..."
          />
        </div>

        {accountGuid && (
          <div>
            <label className="block text-sm font-medium text-foreground-muted mb-1">
              Interest Expense Account
            </label>
            <AccountSelector
              accountTypes={['EXPENSE']}
              value={interestAccountGuid}
              onChange={(guid) => handleInterestAccountChange(guid)}
              placeholder="Select interest expense account..."
            />
          </div>
        )}
      </div>

      {/* Loading state */}
      {loading && <DetectionSkeleton />}

      {/* Error state */}
      {error && !loading && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-5">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <p className="text-sm text-rose-400 font-medium">
                Couldn&apos;t analyze payments. Enter values manually below.
              </p>
              <p className="text-xs text-rose-400/70 mt-1">{error}</p>
              <div className="flex gap-3 mt-3">
                <button
                  type="button"
                  onClick={runDetection}
                  className="text-xs text-cyan-400 hover:text-cyan-300 font-medium"
                >
                  Try Again
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onDetectionComplete({
                      originalAmount: 0,
                      interestRate: 0,
                      monthlyPayment: 0,
                      loanTermMonths: 360,
                      accountGuid,
                      interestAccountGuid,
                    });
                  }}
                  className="text-xs text-foreground-muted hover:text-foreground font-medium"
                >
                  Manual
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Results */}
      {result && !loading && (
        <div className="space-y-4">
          {/* Warnings */}
          {result.warnings.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
              <ul className="space-y-1">
                {result.warnings.map((w, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-amber-400">
                    <svg className="w-3.5 h-3.5 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01" />
                    </svg>
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Detected values */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-surface/30 border border-border rounded-xl p-4">
              <EditableValue
                label="Original Loan Amount"
                value={overrideOriginalAmount ?? result.originalAmount}
                onChange={setOverrideOriginalAmount}
                format={v => fmtFull.format(v)}
                ariaLabel="Original loan amount in dollars"
              />
            </div>
            <div className="bg-surface/30 border border-border rounded-xl p-4">
              <EditableValue
                label="Interest Rate"
                value={overrideInterestRate ?? result.interestRate}
                onChange={setOverrideInterestRate}
                format={v => `${v.toFixed(3)}%`}
                suffix="%"
                ariaLabel="Annual interest rate in percent"
              />
            </div>
            <div className="bg-surface/30 border border-border rounded-xl p-4">
              <EditableValue
                label="Monthly Payment"
                value={overrideMonthlyPayment ?? result.monthlyPayment}
                onChange={setOverrideMonthlyPayment}
                format={v => fmtFull.format(v)}
                ariaLabel="Monthly payment in dollars"
              />
            </div>
            <div className="bg-surface/30 border border-border rounded-xl p-4">
              <EditableValue
                label="Loan Term"
                value={overrideLoanTermMonths ?? result.loanTermMonths ?? estimateTerm(
                  overrideOriginalAmount ?? result.originalAmount,
                  overrideInterestRate ?? result.interestRate,
                  overrideMonthlyPayment ?? result.monthlyPayment,
                )}
                onChange={setOverrideLoanTermMonths}
                format={v => {
                  const y = Math.floor(v / 12);
                  const m = v % 12;
                  if (m === 0) return `${y} years`;
                  return `${y}y ${m}m`;
                }}
                suffix="months"
                ariaLabel="Loan term in months"
              />
            </div>
          </div>

          {/* Confidence & metadata */}
          <div className="flex items-center gap-4 text-xs text-foreground-muted">
            <span>
              Confidence:{' '}
              <span className={
                result.confidence === 'high' ? 'text-emerald-400' :
                result.confidence === 'medium' ? 'text-amber-400' : 'text-rose-400'
              }>
                {result.confidence}
              </span>
            </span>
            <span>{result.paymentsAnalyzed} payments analyzed</span>
          </div>

          {/* Use Values button */}
          <button
            type="button"
            onClick={handleUseValues}
            className="px-5 py-2.5 bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Use These Values
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Utility: estimate loan term from principal, rate, payment           */
/* ------------------------------------------------------------------ */

function estimateTerm(principal: number, annualRate: number, monthlyPayment: number): number {
  if (principal <= 0 || monthlyPayment <= 0) return 360;
  if (annualRate <= 0) return Math.ceil(principal / monthlyPayment);

  const r = annualRate / 100 / 12;
  // n = -log(1 - P*r/M) / log(1+r)
  const arg = 1 - (principal * r) / monthlyPayment;
  if (arg <= 0) return 360; // Payment is too low
  return Math.ceil(-Math.log(arg) / Math.log(1 + r));
}
