'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import AccountPickerDialog from '@/components/AccountPickerDialog';
import ApplyHistoryModal from './ApplyHistoryModal';

type MatchType = 'contains' | 'exact' | 'regex';

const MATCH_TYPE_OPTIONS: { value: MatchType; label: string; description: string }[] = [
  { value: 'contains', label: 'Contains', description: 'Description contains the pattern (case-insensitive)' },
  { value: 'exact', label: 'Exact', description: 'Description equals the pattern (case-insensitive)' },
  { value: 'regex', label: 'Regex', description: 'Description matches the regular expression (case-insensitive)' },
];

interface Rule {
  id: number;
  pattern: string;
  matchType: MatchType;
  accountGuid: string;
  priority: number;
  enabled: boolean;
  hitCount: number;
  lastHitAt: string | null;
  createdAt: string;
  accountName: string | null;
}

interface Suggestion {
  pattern: string;
  accountGuid: string;
  accountName: string | null;
  occurrences: number;
  share: number;
}

interface TestResult {
  matched: boolean;
  rule: { id: number; pattern: string; matchType: MatchType; priority: number } | null;
  accountGuid: string | null;
  accountName: string | null;
  note?: string;
}

interface RuleDraft {
  pattern: string;
  matchType: MatchType;
  accountGuid: string;
  accountName: string;
  priority: string;
}

const EMPTY_DRAFT: RuleDraft = {
  pattern: '',
  matchType: 'contains',
  accountGuid: '',
  accountName: '',
  priority: '0',
};

/** Strip the root/book account name (first colon-delimited segment). */
function stripRoot(fullname: string | null): string {
  if (!fullname) return '(unknown account)';
  const idx = fullname.indexOf(':');
  return idx >= 0 ? fullname.slice(idx + 1) : fullname;
}

function matchTypeBadge(matchType: MatchType) {
  return (
    <span className="text-xs px-1.5 py-0.5 rounded bg-background-tertiary text-foreground-secondary font-medium">
      {MATCH_TYPE_OPTIONS.find(o => o.value === matchType)?.label ?? matchType}
    </span>
  );
}

export default function CategorizationRulesPage() {
  const { success, error: showError } = useToast();

  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(true);
  const [creatingPattern, setCreatingPattern] = useState<string | null>(null);

  // Add / edit form state. editingId === null means the form adds a new rule.
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Apply-to-history modal state
  const [applyRule, setApplyRule] = useState<Rule | null>(null);

  // Test box state
  const [testInput, setTestInput] = useState('');
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const loadRules = useCallback(async () => {
    try {
      const res = await fetch('/api/categorization/rules');
      if (!res.ok) throw new Error('Failed to load rules');
      setRules(await res.json());
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to load rules');
    } finally {
      setLoading(false);
    }
  }, [showError]);

  const loadSuggestions = useCallback(async () => {
    setSuggestionsLoading(true);
    try {
      const res = await fetch('/api/categorization/suggestions');
      if (!res.ok) throw new Error('Failed to load suggestions');
      setSuggestions(await res.json());
    } catch {
      // Suggestions are best-effort; do not toast on load failures
      setSuggestions([]);
    } finally {
      setSuggestionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRules();
    void loadSuggestions();
  }, [loadRules, loadSuggestions]);

  const resetForm = () => {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
  };

  const startEdit = (rule: Rule) => {
    setEditingId(rule.id);
    setDraft({
      pattern: rule.pattern,
      matchType: rule.matchType,
      accountGuid: rule.accountGuid,
      accountName: stripRoot(rule.accountName),
      priority: String(rule.priority),
    });
  };

  const submitForm = async () => {
    const pattern = draft.pattern.trim();
    if (!pattern) {
      showError('Pattern is required');
      return;
    }
    if (!draft.accountGuid) {
      showError('Choose a target account');
      return;
    }
    const priority = parseInt(draft.priority || '0', 10);
    if (isNaN(priority)) {
      showError('Priority must be an integer');
      return;
    }
    if (draft.matchType === 'regex') {
      try {
        new RegExp(pattern, 'i');
      } catch {
        showError('Pattern is not a valid regular expression');
        return;
      }
    }

    setSaving(true);
    try {
      const isEdit = editingId !== null;
      const res = await fetch(
        isEdit ? `/api/categorization/rules/${editingId}` : '/api/categorization/rules',
        {
          method: isEdit ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pattern,
            matchType: draft.matchType,
            accountGuid: draft.accountGuid,
            priority,
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save rule');
      success(isEdit ? 'Rule updated' : 'Rule created');
      resetForm();
      await loadRules();
      void loadSuggestions();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to save rule');
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (rule: Rule) => {
    // Optimistic toggle
    setRules(prev => prev.map(r => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)));
    try {
      const res = await fetch(`/api/categorization/rules/${rule.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      if (!res.ok) throw new Error('Failed to update rule');
    } catch (err) {
      setRules(prev => prev.map(r => (r.id === rule.id ? { ...r, enabled: rule.enabled } : r)));
      showError(err instanceof Error ? err.message : 'Failed to update rule');
    }
  };

  const deleteRule = async (rule: Rule) => {
    if (!window.confirm(`Delete rule "${rule.pattern}"?`)) return;
    try {
      const res = await fetch(`/api/categorization/rules/${rule.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete rule');
      if (editingId === rule.id) resetForm();
      success('Rule deleted');
      await loadRules();
      void loadSuggestions();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to delete rule');
    }
  };

  const runTest = async () => {
    const description = testInput.trim();
    if (!description) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(
        `/api/categorization/test?description=${encodeURIComponent(description)}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to test description');
      setTestResult(data);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to test description');
    } finally {
      setTesting(false);
    }
  };

  const createFromSuggestion = async (s: Suggestion) => {
    setCreatingPattern(s.pattern);
    try {
      const res = await fetch('/api/categorization/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern: s.pattern,
          matchType: 'contains',
          accountGuid: s.accountGuid,
          priority: 0,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create rule');
      success(`Rule created for "${s.pattern}"`);
      setSuggestions(prev => prev.filter(x => x.pattern !== s.pattern));
      await loadRules();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to create rule');
    } finally {
      setCreatingPattern(null);
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Categorization Rules</h1>
        <p className="text-sm text-foreground-secondary mt-1">
          Explicit rules that assign a category account to bank-sync imports by description.
          Rules are checked before the history-based guess; higher priority wins.
        </p>
      </div>

      {/* Add / edit rule form */}
      <div className="mb-6 border border-border rounded-md bg-surface p-4">
        <h2 className="text-sm font-semibold text-foreground mb-3">
          {editingId !== null ? `Edit rule #${editingId}` : 'Add a rule'}
        </h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-48 space-y-1">
            <label className="block text-xs text-foreground-secondary" htmlFor="rule-pattern">Pattern</label>
            <input
              id="rule-pattern"
              type="text"
              value={draft.pattern}
              onChange={e => setDraft(d => ({ ...d, pattern: e.target.value }))}
              placeholder="e.g. KING SOOPERS"
              className="w-full px-3 py-2 text-sm bg-background-tertiary border border-border rounded-md text-foreground focus:outline-none focus:border-border-hover"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-foreground-secondary" htmlFor="rule-match-type">Match type</label>
            <select
              id="rule-match-type"
              value={draft.matchType}
              onChange={e => setDraft(d => ({ ...d, matchType: e.target.value as MatchType }))}
              className="px-2 py-2 text-sm bg-background-tertiary border border-border rounded-md text-foreground focus:outline-none focus:border-border-hover"
              title={MATCH_TYPE_OPTIONS.find(o => o.value === draft.matchType)?.description}
            >
              {MATCH_TYPE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="flex-1 min-w-56 space-y-1">
            <label className="block text-xs text-foreground-secondary">Target account</label>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="w-full px-3 py-2 text-sm text-left bg-background-tertiary border border-border rounded-md hover:border-border-hover transition-colors truncate"
            >
              {draft.accountName ? (
                <span className="text-foreground">{draft.accountName}</span>
              ) : (
                <span className="text-foreground-muted">Choose account…</span>
              )}
            </button>
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-foreground-secondary" htmlFor="rule-priority">Priority</label>
            <input
              id="rule-priority"
              type="number"
              value={draft.priority}
              onChange={e => setDraft(d => ({ ...d, priority: e.target.value }))}
              className="w-20 px-2 py-2 text-sm font-mono text-right bg-background-tertiary border border-border rounded-md text-foreground focus:outline-none focus:border-border-hover"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void submitForm()}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary-hover transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving…' : editingId !== null ? 'Save changes' : 'Add rule'}
            </button>
            {editingId !== null && (
              <button
                onClick={resetForm}
                disabled={saving}
                className="px-3 py-2 text-sm border border-border rounded-md text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Rules table */}
      <div className="mb-8 border border-border rounded-md bg-surface overflow-x-auto">
        {loading ? (
          <div className="py-12 text-center text-sm text-foreground-muted">Loading…</div>
        ) : rules.length === 0 ? (
          <div className="py-12 text-center text-sm text-foreground-muted">
            No rules yet. Add one above, or create one from the suggestions below.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-foreground-muted border-b border-border">
                <th className="px-4 py-2.5">Pattern</th>
                <th className="px-4 py-2.5">Type</th>
                <th className="px-4 py-2.5">Target Account</th>
                <th className="px-4 py-2.5 text-right">Priority</th>
                <th className="px-4 py-2.5 text-center">Enabled</th>
                <th className="px-4 py-2.5 text-right">Hits</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rules.map(rule => (
                <tr
                  key={rule.id}
                  className={`border-b border-border last:border-b-0 hover:bg-surface-hover/40 ${
                    rule.enabled ? '' : 'opacity-60'
                  }`}
                >
                  <td className="px-4 py-2 font-mono text-foreground break-all">{rule.pattern}</td>
                  <td className="px-4 py-2">{matchTypeBadge(rule.matchType)}</td>
                  <td className="px-4 py-2 text-foreground-secondary">{stripRoot(rule.accountName)}</td>
                  <td className="px-4 py-2 text-right font-mono text-foreground-secondary">{rule.priority}</td>
                  <td className="px-4 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={() => void toggleEnabled(rule)}
                      className="w-4 h-4 text-primary bg-background-tertiary border-border-hover rounded focus:ring-primary/50"
                      aria-label={`Enable rule ${rule.pattern}`}
                    />
                  </td>
                  <td
                    className="px-4 py-2 text-right font-mono text-foreground-secondary"
                    title={rule.lastHitAt ? `Last hit ${new Date(rule.lastHitAt).toLocaleString()}` : 'Never hit'}
                  >
                    {rule.hitCount}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2 justify-end">
                      <button
                        onClick={() => setApplyRule(rule)}
                        title="Retroactively apply this rule to historical transactions"
                        className="px-2 py-1 text-xs text-foreground-secondary hover:text-primary hover:bg-surface-hover rounded transition-colors whitespace-nowrap"
                      >
                        Apply to history
                      </button>
                      <button
                        onClick={() => startEdit(rule)}
                        className="px-2 py-1 text-xs text-foreground-secondary hover:text-foreground hover:bg-surface-hover rounded transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => void deleteRule(rule)}
                        className="px-2 py-1 text-xs text-foreground-secondary hover:text-negative hover:bg-surface-hover rounded transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Test a description */}
      <div className="mb-8 border border-border rounded-md bg-surface p-4">
        <h2 className="text-sm font-semibold text-foreground mb-1">Test a description</h2>
        <p className="text-xs text-foreground-secondary mb-3">
          See which rule (if any) an imported description would match. The history-based
          fallback used during sync depends on the bank account and is not simulated here.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={testInput}
            onChange={e => setTestInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void runTest(); }}
            placeholder="e.g. KING SOOPERS #0123 DENVER CO"
            className="flex-1 min-w-64 px-3 py-2 text-sm bg-background-tertiary border border-border rounded-md text-foreground focus:outline-none focus:border-border-hover"
          />
          <button
            onClick={() => void runTest()}
            disabled={testing || !testInput.trim()}
            className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary-hover transition-colors disabled:opacity-50"
          >
            {testing ? 'Testing…' : 'Test'}
          </button>
        </div>
        {testResult && (
          <div className="mt-3 px-3 py-2 text-sm rounded border border-border bg-background-tertiary">
            {testResult.matched && testResult.rule ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-positive font-medium">Match:</span>
                <span className="font-mono text-foreground">{testResult.rule.pattern}</span>
                {matchTypeBadge(testResult.rule.matchType)}
                <span className="text-foreground-muted">&rarr;</span>
                <span className="text-foreground">{stripRoot(testResult.accountName)}</span>
                <span className="text-xs text-foreground-muted">
                  (rule #{testResult.rule.id}, priority {testResult.rule.priority})
                </span>
              </div>
            ) : (
              <span className="text-foreground-secondary">
                No rule matched. {testResult.note}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Learned suggestions */}
      <div className="border border-border rounded-md bg-surface">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Suggested rules</h2>
          <p className="text-xs text-foreground-secondary mt-1">
            Learned from your history: descriptions seen at least 3 times where at least 80%
            went to the same expense or income account, and no existing rule covers them.
          </p>
        </div>
        {suggestionsLoading ? (
          <div className="py-8 text-center text-sm text-foreground-muted">Analyzing history…</div>
        ) : suggestions.length === 0 ? (
          <div className="py-8 text-center text-sm text-foreground-muted">
            No new suggestions. Your rules already cover the recurring descriptions.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-foreground-muted border-b border-border">
                  <th className="px-4 py-2.5">Pattern</th>
                  <th className="px-4 py-2.5">Target Account</th>
                  <th className="px-4 py-2.5 text-right">Seen</th>
                  <th className="px-4 py-2.5 text-right">Consistency</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {suggestions.map(s => (
                  <tr key={`${s.pattern}:${s.accountGuid}`} className="border-b border-border last:border-b-0 hover:bg-surface-hover/40">
                    <td className="px-4 py-2 font-mono text-foreground break-all">{s.pattern}</td>
                    <td className="px-4 py-2 text-foreground-secondary">{stripRoot(s.accountName)}</td>
                    <td className="px-4 py-2 text-right font-mono text-foreground-secondary">{s.occurrences}&times;</td>
                    <td className="px-4 py-2 text-right font-mono text-foreground-secondary">{Math.round(s.share * 100)}%</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => void createFromSuggestion(s)}
                        disabled={creatingPattern !== null}
                        className="px-2.5 py-1 text-xs font-medium border border-primary/40 text-primary rounded hover:bg-primary-light transition-colors disabled:opacity-50"
                      >
                        {creatingPattern === s.pattern ? 'Creating…' : 'Create rule'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <AccountPickerDialog
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(guid, name) => {
          const idx = name.indexOf(':');
          setDraft(d => ({
            ...d,
            accountGuid: guid,
            accountName: idx >= 0 ? name.slice(idx + 1) : name,
          }));
        }}
        title="Select target account"
      />

      <ApplyHistoryModal
        rule={applyRule}
        onClose={() => setApplyRule(null)}
      />
    </div>
  );
}
