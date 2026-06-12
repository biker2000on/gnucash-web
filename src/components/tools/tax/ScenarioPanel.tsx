'use client';

import { useMemo, useState } from 'react';
import { formatCurrency } from '@/lib/format';
import {
  evaluateScenario,
  maxOutScenario,
  remainingHeadroom,
  type ScenarioLimits,
} from '@/lib/tax/scenario';
import {
  SCENARIO_CONTRIBUTION_FIELDS,
  SCENARIO_FIELD_LABELS,
  type ContributionScenario,
  type FederalTaxInputs,
  type ScenarioContributionField,
  type ScenarioResult,
} from '@/lib/tax/types';
import { ContributionLimitBar } from '@/components/reports/ContributionLimitBar';

const MAX_SCENARIOS = 3;

function emptyAdditional(): Record<ScenarioContributionField, number> {
  return { trad401k: 0, roth401k: 0, tradIra: 0, rothIra: 0, hsa: 0 };
}

interface ScenarioPanelProps {
  baseInputs: FederalTaxInputs;
  limits: ScenarioLimits;
  stateCode: string;
  stateFlatRateOverride?: number;
  baselineLiability: number;
  scenarios: ContributionScenario[];
  onScenariosChange: (scenarios: ContributionScenario[]) => void;
  onSaveScenarios?: () => void;
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
}

export default function ScenarioPanel({
  baseInputs,
  limits,
  stateCode,
  stateFlatRateOverride,
  baselineLiability,
  scenarios,
  onScenariosChange,
  onSaveScenarios,
  saveStatus = 'idle',
}: ScenarioPanelProps) {
  const [expanded, setExpanded] = useState<number | null>(scenarios.length > 0 ? 0 : null);

  const results: ScenarioResult[] = useMemo(
    () =>
      scenarios.map(scenario =>
        evaluateScenario({
          baseInputs,
          scenario,
          limits,
          stateCode,
          stateFlatRateOverride,
          baselineLiability,
        }),
      ),
    [scenarios, baseInputs, limits, stateCode, stateFlatRateOverride, baselineLiability],
  );

  const addScenario = (scenario: ContributionScenario) => {
    if (scenarios.length >= MAX_SCENARIOS) return;
    onScenariosChange([...scenarios, scenario]);
    setExpanded(scenarios.length);
  };

  const updateScenario = (index: number, patch: Partial<ContributionScenario>) => {
    onScenariosChange(scenarios.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const removeScenario = (index: number) => {
    onScenariosChange(scenarios.filter((_, i) => i !== index));
    setExpanded(null);
  };

  const presets: Array<{ label: string; build: () => ContributionScenario }> = [
    { label: '+ Max 401(k)', build: () => maxOutScenario('trad401k', 'Max 401(k)', limits) },
    { label: '+ Max HSA', build: () => maxOutScenario('hsa', 'Max HSA', limits) },
    { label: '+ Max Trad IRA', build: () => maxOutScenario('tradIra', 'Max Trad IRA', limits) },
    { label: '+ Custom', build: () => ({ name: `Scenario ${scenarios.length + 1}`, additional: emptyAdditional() }) },
  ];

  return (
    <div className="space-y-4">
      {/* Headroom overview */}
      <div className="grid gap-3 sm:grid-cols-3">
        {(['trad401k', 'tradIra', 'hsa'] as ScenarioContributionField[]).map(field => {
          const group =
            field === 'trad401k' ? (['trad401k', 'roth401k'] as ScenarioContributionField[])
            : field === 'tradIra' ? (['tradIra', 'rothIra'] as ScenarioContributionField[])
            : ([field] as ScenarioContributionField[]);
          const limit = Math.max(...group.map(f => limits.limits[f] ?? 0));
          const used = group.reduce((s, f) => s + (limits.actuals[f] ?? 0), 0);
          if (limit <= 0) return null;
          const label =
            field === 'trad401k' ? '401(k) employee deferral'
            : field === 'tradIra' ? 'IRA (trad + Roth)'
            : 'HSA';
          return (
            <div key={field} className="bg-surface border border-border rounded-md p-3">
              <ContributionLimitBar current={used} limit={limit} label={label} />
            </div>
          );
        })}
      </div>

      {/* Add buttons */}
      <div className="flex flex-wrap items-center gap-2">
        {presets.map(p => (
          <button
            key={p.label}
            onClick={() => addScenario(p.build())}
            disabled={scenarios.length >= MAX_SCENARIOS}
            className="text-xs font-medium px-3 py-1.5 rounded-md border border-border text-foreground-secondary hover:text-primary hover:border-primary/50 disabled:opacity-40 transition-colors"
          >
            {p.label}
          </button>
        ))}
        {onSaveScenarios && scenarios.length > 0 && (
          <button
            onClick={onSaveScenarios}
            disabled={saveStatus === 'saving'}
            className="ml-auto text-xs font-medium px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary-hover disabled:opacity-40 transition-colors"
          >
            {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved ✓' : 'Save scenarios'}
          </button>
        )}
      </div>

      {scenarios.length === 0 && (
        <p className="text-sm text-foreground-muted">
          Add a scenario to model additional retirement or HSA contributions and see the tax impact.
        </p>
      )}

      {/* Scenario comparison cards */}
      {scenarios.length > 0 && (
        <div className={`grid gap-4 ${scenarios.length === 1 ? '' : scenarios.length === 2 ? 'lg:grid-cols-2' : 'lg:grid-cols-3'}`}>
          {scenarios.map((scenario, i) => {
            const result = results[i];
            const isOpen = expanded === i;
            return (
              <div key={i} className={`bg-surface border rounded-lg p-4 space-y-3 ${result.valid ? 'border-border' : 'border-error/60'}`}>
                <div className="flex items-center gap-2">
                  <input
                    value={scenario.name}
                    onChange={e => updateScenario(i, { name: e.target.value })}
                    className="flex-1 bg-transparent text-sm font-semibold text-foreground border-b border-transparent focus:border-border focus:outline-none"
                  />
                  <button
                    onClick={() => setExpanded(isOpen ? null : i)}
                    className="text-xs text-foreground-muted hover:text-foreground"
                  >
                    {isOpen ? 'Hide inputs' : 'Edit inputs'}
                  </button>
                  <button
                    onClick={() => removeScenario(i)}
                    className="text-xs text-foreground-muted hover:text-error"
                    aria-label={`Remove ${scenario.name}`}
                  >
                    ✕
                  </button>
                </div>

                {/* Inputs */}
                {isOpen && (
                  <div className="space-y-2">
                    {SCENARIO_CONTRIBUTION_FIELDS.map(field => {
                      const headroom = remainingHeadroom(field, limits);
                      return (
                        <div key={field} className="flex items-center gap-2">
                          <label className="flex-1 text-xs text-foreground-secondary">
                            {SCENARIO_FIELD_LABELS[field]}
                            {headroom !== null && (
                              <span className="block text-[10px] text-foreground-muted">
                                {formatCurrency(Math.max(0, headroom))} headroom left
                              </span>
                            )}
                          </label>
                          <input
                            type="number"
                            min={0}
                            step={500}
                            value={scenario.additional[field] || ''}
                            placeholder="0"
                            onChange={e =>
                              updateScenario(i, {
                                additional: {
                                  ...scenario.additional,
                                  [field]: Math.max(0, parseFloat(e.target.value) || 0),
                                },
                              })
                            }
                            className="w-28 bg-background-tertiary border border-border rounded-md px-2 py-1 text-xs text-right font-mono text-foreground focus:outline-none focus:border-primary"
                          />
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Validation issues */}
                {result.issues.map((issue, j) => (
                  <p key={j} className="text-[11px] text-error bg-error/10 border border-error/30 rounded px-2 py-1.5">
                    {issue.message}
                  </p>
                ))}

                {/* Results */}
                <dl className="space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-foreground-muted">Additional contributions</dt>
                    <dd className="font-mono text-foreground">{formatCurrency(result.totalAdditional)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-foreground-muted">New liability (fed + state)</dt>
                    <dd className="font-mono text-foreground">{formatCurrency(result.totalLiability)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-foreground-muted">Tax saved</dt>
                    <dd className={`font-mono ${result.taxSaved > 0 ? 'text-positive' : 'text-foreground-secondary'}`}>
                      {formatCurrency(result.taxSaved)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-foreground-muted">Marginal / effective rate</dt>
                    <dd className="font-mono text-foreground-secondary">
                      {(result.marginalRate * 100).toFixed(0)}% / {(result.effectiveRate * 100).toFixed(1)}%
                    </dd>
                  </div>
                  <div className="flex justify-between border-t border-border pt-1.5">
                    <dt className="text-foreground-secondary">Take-home change</dt>
                    <dd className={`font-mono font-medium ${result.takeHomeChange >= 0 ? 'text-positive' : 'text-negative'}`}>
                      {formatCurrency(result.takeHomeChange)}
                    </dd>
                  </div>
                </dl>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
