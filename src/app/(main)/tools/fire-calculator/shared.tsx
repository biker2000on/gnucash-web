'use client';

/**
 * Shared types, formatters, and small presentational components for the
 * FIRE calculator page.
 */

import type { FireAssumptions } from '@/lib/fire/assumptions';

/* ------------------------------------------------------------------ */
/* Formatters                                                          */
/* ------------------------------------------------------------------ */

export const fmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export const fmtFull = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function fmtCompact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${Math.round(value)}`;
}

export function fmtPct(fraction: number, digits = 0): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface DataDrivenValue {
  computed: number | null;
  override: number | null;
}

export type LoadingState = 'loading' | 'loaded' | 'error' | 'empty';

export interface KPIData {
  netWorth: number;
  totalIncome: number;
  totalExpenses: number;
  savingsRate: number;
  investmentValue: number;
}

export interface FireConfig {
  id: number;
  name: string;
  tool_type: string;
  account_guid: string | null;
  config: {
    overrides?: Record<string, number | null>;
    currentAge?: number;
    targetRetirementAge?: number;
    safeWithdrawalRate?: number;
    inflationRate?: number;
    adjustForInflation?: boolean;
    /** New (v2): full assumption set, additive and backward compatible */
    assumptions?: Partial<FireAssumptions>;
  };
  created_at: string;
  updated_at: string;
}

export function effectiveValue(ddv: DataDrivenValue, fallback: number): number {
  if (ddv.override !== null) return ddv.override;
  if (ddv.computed !== null) return ddv.computed;
  return fallback;
}

export function sourceLabel(ddv: DataDrivenValue): 'data' | 'override' | 'manual' {
  if (ddv.override !== null) return 'override';
  if (ddv.computed !== null) return 'data';
  return 'manual';
}

/* ------------------------------------------------------------------ */
/* InputField                                                          */
/* ------------------------------------------------------------------ */

interface InputFieldProps {
  label: string;
  value: number;
  onChange: (val: number) => void;
  type: 'number' | 'currency' | 'percent';
  suffix?: string;
  step?: number;
  min?: number;
  max?: number;
}

export function InputField({ label, value, onChange, type, suffix, step, min, max }: InputFieldProps) {
  const prefix = type === 'currency' ? '$' : undefined;
  const sfx = type === 'percent' ? '%' : suffix;

  return (
    <div>
      <label className="block text-sm font-medium text-foreground-muted mb-1">{label}</label>
      <div className="relative">
        {prefix && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted text-sm pointer-events-none">
            {prefix}
          </span>
        )}
        <input
          type="number"
          value={value}
          onChange={e => onChange(parseFloat(e.target.value) || 0)}
          step={step ?? (type === 'percent' ? 0.1 : type === 'currency' ? 1000 : 1)}
          min={min}
          max={max}
          className={`w-full bg-input-bg border border-border rounded-lg py-2 text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent ${
            prefix ? 'pl-7 pr-3' : sfx ? 'pl-3 pr-10' : 'pl-3 pr-3'
          }${prefix && sfx ? ' pr-10' : ''}`}
        />
        {sfx && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-foreground-muted text-sm pointer-events-none">
            {sfx}
          </span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toggle                                                              */
/* ------------------------------------------------------------------ */

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
}

export function Toggle({ checked, onChange, label, description }: ToggleProps) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-transparent ${
          checked ? 'bg-primary' : 'bg-foreground-muted/30'
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
      <div>
        <span className="text-sm font-medium text-foreground">{label}</span>
        {description && <p className="text-xs text-foreground-muted">{description}</p>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Segmented control                                                   */
/* ------------------------------------------------------------------ */

interface SegmentedProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
}

export function Segmented<T extends string>({ options, value, onChange, ariaLabel }: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex rounded-lg border border-border bg-background-tertiary p-0.5"
    >
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors duration-150 ${
            value === opt.value
              ? 'bg-primary/15 text-primary'
              : 'text-foreground-muted hover:text-foreground'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Data-driven input with inline override                              */
/* ------------------------------------------------------------------ */

interface DataDrivenInputFieldProps {
  label: string;
  field: string;
  ddv: DataDrivenValue;
  fallback: number;
  type: 'currency' | 'percent';
  editingField: string | null;
  editingValue: string;
  onStartEdit: (field: string, value: number) => void;
  onEditChange: (value: string) => void;
  onCommit: (field: string) => void;
  onReset: (field: string) => void;
}

export function DataDrivenInputField({
  label,
  field,
  ddv,
  fallback,
  type,
  editingField,
  editingValue,
  onStartEdit,
  onEditChange,
  onCommit,
  onReset,
}: DataDrivenInputFieldProps) {
  const value = effectiveValue(ddv, fallback);
  const source = sourceLabel(ddv);
  const isEditing = editingField === field;
  const prefix = type === 'currency' ? '$' : undefined;
  const sfx = type === 'percent' ? '%' : undefined;

  const sourceText = source === 'data' ? '(from your data)' : source === 'override' ? '(override)' : '';

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <label className="block text-sm font-medium text-foreground-muted">{label}</label>
        {sourceText && (
          <span className={`text-xs ${source === 'data' ? 'text-primary' : 'text-amber-400'}`}>
            {sourceText}
          </span>
        )}
        {source === 'override' && ddv.computed !== null && (
          <button
            type="button"
            onClick={() => onReset(field)}
            className="text-xs text-foreground-muted hover:text-rose-400 transition-colors"
            title="Reset to computed value"
          >
            x
          </button>
        )}
      </div>
      {isEditing ? (
        <div className="relative">
          {prefix && (
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted text-sm pointer-events-none">
              {prefix}
            </span>
          )}
          <input
            type="number"
            value={editingValue}
            onChange={e => onEditChange(e.target.value)}
            onBlur={() => onCommit(field)}
            onKeyDown={e => { if (e.key === 'Enter') onCommit(field); if (e.key === 'Escape') onCommit(field); }}
            autoFocus
            step={type === 'percent' ? 0.1 : 1000}
            className={`w-full bg-input-bg border border-primary rounded-lg py-2 text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent ${
              prefix ? 'pl-7 pr-3' : sfx ? 'pl-3 pr-10' : 'pl-3 pr-3'
            }${prefix && sfx ? ' pr-10' : ''}`}
          />
          {sfx && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-foreground-muted text-sm pointer-events-none">
              {sfx}
            </span>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onStartEdit(field, value)}
          className="w-full text-left bg-input-bg border border-border rounded-lg py-2 px-3 text-foreground text-sm hover:border-primary/50 transition-colors group flex items-center justify-between"
        >
          <span className="font-mono" style={{ fontFeatureSettings: "'tnum'" }}>
            {type === 'currency' ? fmt.format(value) : `${value.toFixed(type === 'percent' ? 2 : 0)}%`}
          </span>
          <svg className="w-3.5 h-3.5 text-foreground-muted opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Result Card                                                         */
/* ------------------------------------------------------------------ */

interface ResultCardProps {
  label: string;
  value: string;
  sublabel: string;
  color: 'primary' | 'emerald' | 'purple' | 'amber';
  progress?: number;
}

export function ResultCard({ label, value, sublabel, color, progress }: ResultCardProps) {
  const backgrounds: Record<string, string> = {
    primary: 'bg-primary/10',
    emerald: 'bg-primary/10',
    purple: 'bg-purple-500/10',
    amber: 'bg-amber-500/10',
  };
  const accents: Record<string, string> = {
    primary: 'text-primary',
    emerald: 'text-primary',
    purple: 'text-purple-400',
    amber: 'text-amber-400',
  };
  const bars: Record<string, string> = {
    primary: 'bg-primary',
    emerald: 'bg-primary',
    purple: 'bg-purple-500',
    amber: 'bg-amber-500',
  };

  return (
    <div className={`${backgrounds[color]} backdrop-blur-xl border border-border rounded-xl p-5`}>
      <p className="text-xs font-medium text-foreground-muted uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 font-mono ${accents[color]}`} style={{ fontFeatureSettings: "'tnum'" }}>
        {value}
      </p>
      <p className="text-xs text-foreground-muted mt-1">{sublabel}</p>
      {progress !== undefined && (
        <div className="mt-3 h-2 bg-foreground-muted/20 rounded-full overflow-hidden">
          <div
            className={`h-full ${bars[color]} rounded-full transition-all duration-500`}
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Saved Config Card                                                   */
/* ------------------------------------------------------------------ */

interface SavedCardProps {
  config: FireConfig;
  onLoad: (config: FireConfig) => void;
  onDelete: (id: number) => void;
  isDeleting: boolean;
}

export function SavedConfigCard({ config, onLoad, onDelete, isDeleting }: SavedCardProps) {
  return (
    <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-4 flex items-center justify-between gap-4 hover:border-primary/30 transition-colors">
      <button
        type="button"
        onClick={() => onLoad(config)}
        className="flex-1 text-left min-w-0"
      >
        <h3 className="text-sm font-semibold text-foreground truncate">{config.name}</h3>
        <div className="flex items-center gap-3 mt-1 text-xs text-foreground-muted">
          {config.config.safeWithdrawalRate !== undefined && (
            <span>SWR: {config.config.safeWithdrawalRate}%</span>
          )}
          {config.config.currentAge !== undefined && (
            <span>Age: {config.config.currentAge}</span>
          )}
          {config.config.assumptions?.returnMode && (
            <span>{config.config.assumptions.returnMode === 'historical' ? 'Monte Carlo' : 'Fixed rate'}</span>
          )}
        </div>
      </button>
      <button
        type="button"
        onClick={() => onDelete(config.id)}
        disabled={isDeleting}
        className="shrink-0 p-1.5 text-foreground-muted hover:text-rose-400 transition-colors disabled:opacity-50"
        title="Delete saved configuration"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      </button>
    </div>
  );
}
