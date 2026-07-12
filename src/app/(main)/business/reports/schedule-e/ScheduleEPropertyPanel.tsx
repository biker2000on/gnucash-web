'use client';

import { useMemo, useState } from 'react';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { generateGuid } from '@/lib/gnucash';
import type {
    DepreciableAsset,
    DepreciationMethod,
    ScheduleEProperty,
} from '@/lib/reports/schedule-e';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

export interface ScheduleEPanelAccount {
    guid: string;
    name: string;
    fullname: string;
    accountType: string;
    /** Keyword-heuristic line for expense accounts ('3' for income). */
    keywordLine: string | null;
}

export interface ScheduleELineOption {
    line: string;
    label: string;
}

interface ScheduleEPropertyPanelProps {
    properties: ScheduleEProperty[];
    accounts: ScheduleEPanelAccount[];
    lineOptions: ScheduleELineOption[];
    saving: boolean;
    onSave: (properties: ScheduleEProperty[]) => Promise<void>;
}

function LineSelect({
    value,
    options,
    onChange,
    className = '',
}: {
    value: string;
    options: ScheduleELineOption[];
    onChange: (v: string) => void;
    className?: string;
}) {
    return (
        <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={`bg-background-tertiary border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary ${className}`}
        >
            <option value="">— Auto (keyword) —</option>
            {options.map((o) => (
                <option key={o.line} value={o.line}>
                    {o.line} · {o.label}
                </option>
            ))}
        </select>
    );
}

function newAsset(): DepreciableAsset {
    return {
        id: generateGuid(),
        description: '',
        costBasis: 0,
        landValue: 0,
        inServiceDate: new Date().toISOString().slice(0, 10),
        method: 'residential',
        disposalDate: null,
    };
}

function newProperty(): ScheduleEProperty {
    return { id: generateGuid(), name: '', accountGuids: [], overrides: {}, assets: [] };
}

function clone(properties: ScheduleEProperty[]): ScheduleEProperty[] {
    return JSON.parse(JSON.stringify(properties)) as ScheduleEProperty[];
}

/** First client-side problem with the draft, or null when saveable. */
function validateDraft(draft: ScheduleEProperty[]): string | null {
    for (const p of draft) {
        const label = p.name.trim() || '(unnamed property)';
        if (!p.name.trim()) return 'Every property needs a name.';
        for (const a of p.assets) {
            if (!a.description.trim()) return `An asset on ${label} needs a description.`;
            if (!(a.costBasis > 0)) return `Asset "${a.description || '?'}" needs a positive cost basis.`;
            if (a.landValue < 0 || a.landValue > a.costBasis)
                return `Asset "${a.description}": land value must be between 0 and the cost basis.`;
            if (!a.inServiceDate) return `Asset "${a.description}" needs an in-service date.`;
            if (a.disposalDate && a.disposalDate < a.inServiceDate)
                return `Asset "${a.description}": disposal date is before the in-service date.`;
        }
    }
    return null;
}

export default function ScheduleEPropertyPanel({
    properties,
    accounts,
    lineOptions,
    saving,
    onSave,
}: ScheduleEPropertyPanelProps) {
    const [draft, setDraft] = useState<ScheduleEProperty[]>(() => clone(properties));

    // Re-sync the draft when the server copy changes (after a save/refetch),
    // using the render-phase "reset state on prop change" pattern.
    const serverSnapshot = JSON.stringify(properties);
    const [syncedSnapshot, setSyncedSnapshot] = useState(serverSnapshot);
    if (syncedSnapshot !== serverSnapshot) {
        setSyncedSnapshot(serverSnapshot);
        setDraft(clone(properties));
    }

    const dirty = JSON.stringify(draft) !== serverSnapshot;
    const validationError = useMemo(() => validateDraft(draft), [draft]);

    const accountByGuid = useMemo(
        () => new Map(accounts.map((a) => [a.guid, a])),
        [accounts],
    );
    const labelByLine = useMemo(() => {
        const m = new Map<string, string>();
        for (const o of lineOptions) m.set(o.line, o.label);
        return m;
    }, [lineOptions]);

    const updateProperty = (id: string, patch: Partial<ScheduleEProperty>) => {
        setDraft((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    };

    const updateAsset = (propertyId: string, assetId: string, patch: Partial<DepreciableAsset>) => {
        setDraft((prev) =>
            prev.map((p) =>
                p.id === propertyId
                    ? {
                          ...p,
                          assets: p.assets.map((a) =>
                              a.id === assetId ? { ...a, ...patch } : a,
                          ),
                      }
                    : p,
            ),
        );
    };

    /** Member EXPENSE accounts of a property (selected roots + descendants). */
    const memberExpenseAccounts = (p: ScheduleEProperty): ScheduleEPanelAccount[] => {
        const roots = p.accountGuids
            .map((g) => accountByGuid.get(g))
            .filter((a): a is ScheduleEPanelAccount => a !== undefined);
        const rootGuids = new Set(roots.map((r) => r.guid));
        const prefixes = roots.map((r) => `${r.fullname}:`);
        return accounts.filter(
            (a) =>
                a.accountType === 'EXPENSE' &&
                (rootGuids.has(a.guid) || prefixes.some((pre) => a.fullname.startsWith(pre))),
        );
    };

    const handleSave = async () => {
        if (!dirty || validationError) return;
        await onSave(draft);
    };

    return (
        <div className="space-y-4">
            {draft.map((p) => {
                const members = memberExpenseAccounts(p);
                return (
                    <div key={p.id} className="border border-border rounded-lg p-3 space-y-3">
                        {/* Name + remove */}
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                value={p.name}
                                onChange={(e) => updateProperty(p.id, { name: e.target.value })}
                                placeholder="Property name (e.g. 123 Main St)"
                                className="flex-1 min-w-0 bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:border-primary"
                            />
                            <button
                                onClick={() =>
                                    setDraft((prev) => prev.filter((x) => x.id !== p.id))
                                }
                                className="text-xs px-2.5 py-1.5 rounded-md border border-border text-foreground-secondary hover:text-error hover:border-error/50 transition-colors shrink-0"
                            >
                                Remove property
                            </button>
                        </div>

                        {/* Account subtrees */}
                        <div className="space-y-1.5">
                            <div className="text-xs font-medium text-foreground-secondary uppercase tracking-wider">
                                Account subtrees
                            </div>
                            {p.accountGuids.length === 0 && (
                                <p className="text-xs text-foreground-muted">
                                    Pick the income and expense subtrees that belong to this
                                    property (e.g. &quot;Income:Rental:123 Main St&quot;). All
                                    descendant accounts are included.
                                </p>
                            )}
                            {p.accountGuids.map((guid) => {
                                const a = accountByGuid.get(guid);
                                return (
                                    <div
                                        key={guid}
                                        className="flex items-center justify-between gap-2 bg-background-tertiary/50 border border-border/50 rounded-md px-2.5 py-1.5"
                                    >
                                        <span className="text-xs text-foreground truncate">
                                            {a ? a.fullname : guid}
                                            {a && (
                                                <span className="ml-2 text-[10px] uppercase text-foreground-muted">
                                                    {a.accountType}
                                                </span>
                                            )}
                                        </span>
                                        <button
                                            onClick={() =>
                                                updateProperty(p.id, {
                                                    accountGuids: p.accountGuids.filter(
                                                        (g) => g !== guid,
                                                    ),
                                                })
                                            }
                                            aria-label="Remove subtree"
                                            className="text-foreground-muted hover:text-error text-sm leading-none px-1"
                                        >
                                            ×
                                        </button>
                                    </div>
                                );
                            })}
                            {/* key resets the selector's display text after each pick */}
                            <AccountSelector
                                key={`${p.id}-${p.accountGuids.length}`}
                                value=""
                                onChange={(guid) => {
                                    if (guid && !p.accountGuids.includes(guid)) {
                                        updateProperty(p.id, {
                                            accountGuids: [...p.accountGuids, guid],
                                        });
                                    }
                                }}
                                placeholder="Add an income or expense subtree..."
                                accountTypes={['INCOME', 'EXPENSE']}
                                compact
                            />
                        </div>

                        {/* Per-account line overrides */}
                        {members.length > 0 && (
                            <div className="space-y-1.5">
                                <div className="text-xs font-medium text-foreground-secondary uppercase tracking-wider">
                                    Expense line overrides
                                </div>
                                <div className="border border-border rounded-md overflow-hidden max-h-64 overflow-y-auto">
                                    <table className="w-full text-sm">
                                        <tbody>
                                            {members.map((a) => {
                                                const override = p.overrides[a.guid] ?? '';
                                                return (
                                                    <tr
                                                        key={a.guid}
                                                        className="border-t border-border first:border-t-0 hover:bg-surface-hover"
                                                    >
                                                        <td className="px-3 py-1.5">
                                                            <div className="text-foreground text-xs">
                                                                {a.name}
                                                            </div>
                                                            <div className="text-[11px] text-foreground-muted truncate max-w-md">
                                                                {a.fullname}
                                                            </div>
                                                        </td>
                                                        <td className="px-3 py-1.5 text-right">
                                                            <LineSelect
                                                                value={override}
                                                                options={lineOptions}
                                                                onChange={(v) => {
                                                                    const overrides = {
                                                                        ...p.overrides,
                                                                    };
                                                                    if (v) overrides[a.guid] = v;
                                                                    else delete overrides[a.guid];
                                                                    updateProperty(p.id, {
                                                                        overrides,
                                                                    });
                                                                }}
                                                            />
                                                            {!override && (
                                                                <span
                                                                    className="ml-2 text-[11px] text-foreground-muted font-mono"
                                                                    style={TNUM}
                                                                    title={
                                                                        a.keywordLine
                                                                            ? `Keyword: ${labelByLine.get(a.keywordLine) ?? ''}`
                                                                            : 'No keyword match — falls to 19 Other'
                                                                    }
                                                                >
                                                                    auto → {a.keywordLine ?? '19'}
                                                                </span>
                                                            )}
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}

                        {/* Depreciable assets */}
                        <div className="space-y-1.5">
                            <div className="text-xs font-medium text-foreground-secondary uppercase tracking-wider">
                                Depreciable assets
                            </div>
                            {p.assets.length > 0 && (
                                <div className="border border-border rounded-md overflow-x-auto">
                                    <table className="w-full min-w-[760px] text-xs">
                                        <thead className="bg-background-tertiary text-foreground-muted">
                                            <tr className="text-left">
                                                <th className="px-2.5 py-2 font-medium">Description</th>
                                                <th className="px-2.5 py-2 font-medium w-28">Cost basis</th>
                                                <th className="px-2.5 py-2 font-medium w-28">Land value</th>
                                                <th className="px-2.5 py-2 font-medium w-36">In service</th>
                                                <th className="px-2.5 py-2 font-medium w-40">Method</th>
                                                <th className="px-2.5 py-2 font-medium w-36">Disposed</th>
                                                <th className="px-2.5 py-2 w-8" />
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {p.assets.map((a) => (
                                                <tr key={a.id} className="border-t border-border">
                                                    <td className="px-2.5 py-1.5">
                                                        <input
                                                            type="text"
                                                            value={a.description}
                                                            onChange={(e) =>
                                                                updateAsset(p.id, a.id, {
                                                                    description: e.target.value,
                                                                })
                                                            }
                                                            placeholder="Building at 123 Main St"
                                                            className="w-full bg-background-tertiary border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary"
                                                        />
                                                    </td>
                                                    <td className="px-2.5 py-1.5">
                                                        <input
                                                            type="number"
                                                            min={0}
                                                            step="0.01"
                                                            value={a.costBasis || ''}
                                                            onChange={(e) =>
                                                                updateAsset(p.id, a.id, {
                                                                    costBasis:
                                                                        parseFloat(e.target.value) || 0,
                                                                })
                                                            }
                                                            className="w-full bg-background-tertiary border border-border rounded px-2 py-1 text-xs text-foreground text-right font-mono focus:outline-none focus:border-primary"
                                                            style={TNUM}
                                                        />
                                                    </td>
                                                    <td className="px-2.5 py-1.5">
                                                        <input
                                                            type="number"
                                                            min={0}
                                                            step="0.01"
                                                            value={a.landValue || ''}
                                                            onChange={(e) =>
                                                                updateAsset(p.id, a.id, {
                                                                    landValue:
                                                                        parseFloat(e.target.value) || 0,
                                                                })
                                                            }
                                                            className="w-full bg-background-tertiary border border-border rounded px-2 py-1 text-xs text-foreground text-right font-mono focus:outline-none focus:border-primary"
                                                            style={TNUM}
                                                        />
                                                    </td>
                                                    <td className="px-2.5 py-1.5">
                                                        <input
                                                            type="date"
                                                            value={a.inServiceDate}
                                                            onChange={(e) =>
                                                                updateAsset(p.id, a.id, {
                                                                    inServiceDate: e.target.value,
                                                                })
                                                            }
                                                            className="w-full bg-background-tertiary border border-border rounded px-2 py-1 text-xs text-foreground font-mono focus:outline-none focus:border-primary"
                                                        />
                                                    </td>
                                                    <td className="px-2.5 py-1.5">
                                                        <select
                                                            value={a.method}
                                                            onChange={(e) =>
                                                                updateAsset(p.id, a.id, {
                                                                    method: e.target
                                                                        .value as DepreciationMethod,
                                                                })
                                                            }
                                                            className="w-full bg-background-tertiary border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary"
                                                        >
                                                            <option value="residential">
                                                                Residential (27.5 yr)
                                                            </option>
                                                            <option value="commercial">
                                                                Commercial (39 yr)
                                                            </option>
                                                        </select>
                                                    </td>
                                                    <td className="px-2.5 py-1.5">
                                                        <input
                                                            type="date"
                                                            value={a.disposalDate ?? ''}
                                                            onChange={(e) =>
                                                                updateAsset(p.id, a.id, {
                                                                    disposalDate:
                                                                        e.target.value || null,
                                                                })
                                                            }
                                                            className="w-full bg-background-tertiary border border-border rounded px-2 py-1 text-xs text-foreground font-mono focus:outline-none focus:border-primary"
                                                        />
                                                    </td>
                                                    <td className="px-2.5 py-1.5 text-center">
                                                        <button
                                                            onClick={() =>
                                                                updateProperty(p.id, {
                                                                    assets: p.assets.filter(
                                                                        (x) => x.id !== a.id,
                                                                    ),
                                                                })
                                                            }
                                                            aria-label="Remove asset"
                                                            className="text-foreground-muted hover:text-error text-sm leading-none px-1"
                                                        >
                                                            ×
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                            <button
                                onClick={() =>
                                    updateProperty(p.id, { assets: [...p.assets, newAsset()] })
                                }
                                className="text-xs px-2.5 py-1.5 rounded-md border border-border text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors"
                            >
                                + Add asset
                            </button>
                            <p className="text-[11px] text-foreground-muted">
                                Straight-line, mid-month convention. The land value is excluded
                                from the depreciable basis. Line 18 shows the computed
                                depreciation for the selected tax year.
                            </p>
                        </div>
                    </div>
                );
            })}

            {draft.length === 0 && (
                <p className="text-sm text-foreground-muted">
                    No rental properties defined yet. Add one to build the report.
                </p>
            )}

            {/* Footer actions */}
            <div className="flex flex-wrap items-center gap-3">
                <button
                    onClick={() => setDraft((prev) => [...prev, newProperty()])}
                    className="text-xs font-medium px-3 py-1.5 rounded-md border border-border text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors"
                >
                    + Add property
                </button>
                <button
                    onClick={handleSave}
                    disabled={!dirty || !!validationError || saving}
                    className="text-xs font-medium px-3 py-1.5 rounded-md bg-primary text-primary-foreground disabled:opacity-40 hover:bg-primary-hover transition-colors"
                >
                    {saving ? 'Saving…' : dirty ? 'Save properties' : 'Saved'}
                </button>
                {dirty && validationError && (
                    <span className="text-xs text-warning">{validationError}</span>
                )}
            </div>
        </div>
    );
}
