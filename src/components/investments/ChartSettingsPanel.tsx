'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import type { ChartDefaults } from './PerformanceChart';

interface ChartSettingsPanelProps {
  currentDefaults?: ChartDefaults;
  onSettingsChange: (defaults: ChartDefaults) => void;
}

const PERIOD_OPTIONS = ['1M', '3M', '6M', '1Y', '3Y', '5Y', 'ALL'];

export function ChartSettingsPanel({ currentDefaults, onSettingsChange }: ChartSettingsPanelProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const [sp500Enabled, setSp500Enabled] = useState(currentDefaults?.sp500Enabled ?? false);
  const [djiaEnabled, setDjiaEnabled] = useState(currentDefaults?.djiaEnabled ?? false);
  const [defaultPeriod, setDefaultPeriod] = useState(currentDefaults?.defaultPeriod ?? '1Y');
  const [defaultMode, setDefaultMode] = useState<'dollar' | 'percent'>(currentDefaults?.defaultMode ?? 'dollar');

  // Sync local state when currentDefaults changes
  useEffect(() => {
    if (currentDefaults) {
      setSp500Enabled(currentDefaults.sp500Enabled);
      setDjiaEnabled(currentDefaults.djiaEnabled);
      setDefaultPeriod(currentDefaults.defaultPeriod);
      setDefaultMode(currentDefaults.defaultMode);
    }
  }, [currentDefaults]);

  // Close panel on outside click
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(false);
    try {
      const res = await fetch('/api/user/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preferences: {
            'performance_chart.sp500_default': sp500Enabled,
            'performance_chart.djia_default': djiaEnabled,
            'performance_chart.default_period': defaultPeriod,
            'performance_chart.default_mode': defaultMode,
          },
        }),
      });

      if (res.ok) {
        onSettingsChange({
          sp500Enabled,
          djiaEnabled,
          defaultPeriod,
          defaultMode,
        });
        setSaved(true);
        setTimeout(() => {
          setSaved(false);
          setOpen(false);
        }, 1200);
      } else {
        setSaveError(true);
        setTimeout(() => setSaveError(false), 3000);
      }
    } catch (err) {
      console.error('Failed to save chart settings:', err);
      setSaveError(true);
      setTimeout(() => setSaveError(false), 3000);
    } finally {
      setSaving(false);
    }
  }, [sp500Enabled, djiaEnabled, defaultPeriod, defaultMode, onSettingsChange]);

  return (
    <div className="relative" ref={panelRef}>
      {/* Gear icon */}
      <button
        onClick={() => setOpen(!open)}
        title="Chart settings"
        className="p-1 text-foreground-muted hover:text-foreground transition-colors rounded"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.38.138.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>

      {/* Settings dropdown panel */}
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-64 bg-background-secondary border border-border rounded-lg shadow-xl p-4 space-y-4">
          <h4 className="text-sm font-semibold text-foreground">Chart Defaults</h4>

          {/* Default Comparison Lines */}
          <div className="space-y-2">
            <label className="text-xs text-foreground-secondary font-medium">Comparison Lines</label>
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-sm text-foreground-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={sp500Enabled}
                  onChange={(e) => setSp500Enabled(e.target.checked)}
                  className="rounded border-border bg-background-tertiary"
                />
                S&P 500 on by default
              </label>
              <label className="flex items-center gap-2 text-sm text-foreground-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={djiaEnabled}
                  onChange={(e) => setDjiaEnabled(e.target.checked)}
                  className="rounded border-border bg-background-tertiary"
                />
                DJIA on by default
              </label>
            </div>
          </div>

          {/* Default Time Period */}
          <div className="space-y-1">
            <label className="text-xs text-foreground-secondary font-medium">Default Period</label>
            <select
              value={defaultPeriod}
              onChange={(e) => setDefaultPeriod(e.target.value)}
              className="w-full px-2 py-1 text-sm bg-background-tertiary border border-border rounded text-foreground"
            >
              {PERIOD_OPTIONS.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          {/* Default Display Mode */}
          <div className="space-y-1">
            <label className="text-xs text-foreground-secondary font-medium">Default Mode</label>
            <div className="flex gap-2">
              <label className="flex items-center gap-1 text-sm text-foreground-secondary cursor-pointer">
                <input
                  type="radio"
                  name="defaultMode"
                  checked={defaultMode === 'dollar'}
                  onChange={() => setDefaultMode('dollar')}
                  className="border-border bg-background-tertiary"
                />
                $ Value
              </label>
              <label className="flex items-center gap-1 text-sm text-foreground-secondary cursor-pointer">
                <input
                  type="radio"
                  name="defaultMode"
                  checked={defaultMode === 'percent'}
                  onChange={() => setDefaultMode('percent')}
                  className="border-border bg-background-tertiary"
                />
                % Change
              </label>
            </div>
          </div>

          {/* Save button */}
          <button
            onClick={handleSave}
            disabled={saving}
            className={`w-full px-3 py-1.5 text-sm rounded transition-colors ${
              saveError
                ? 'bg-red-600 text-white'
                : saved
                  ? 'bg-emerald-600 text-white'
                  : 'bg-cyan-600 hover:bg-cyan-500 text-white disabled:opacity-50'
            }`}
          >
            {saveError ? 'Save failed' : saved ? 'Saved!' : saving ? 'Saving...' : 'Save Defaults'}
          </button>
        </div>
      )}
    </div>
  );
}
