'use client';

import { useMemo, useState } from 'react';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { MobileCard } from '@/components/ui/MobileCard';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

export interface ScheduleCMappingAccount {
    guid: string;
    name: string;
    fullname: string;
    accountType: string;
    /** Keyword-heuristic line, or null when nothing matched (→ line 27a). */
    keywordLine: string | null;
}

export interface ScheduleCLineOption {
    line: string;
    label: string;
}

interface ScheduleCMappingPanelProps {
    accounts: ScheduleCMappingAccount[];
    /** Persisted overrides: accountGuid → Schedule C line. */
    mappings: Record<string, string>;
    lineOptions: ScheduleCLineOption[];
    saving: boolean;
    onSave: (changes: Array<{ accountGuid: string; line: string | null }>) => Promise<void>;
}

function LineSelect({
    value,
    options,
    onChange,
    className = '',
}: {
    value: string;
    options: ScheduleCLineOption[];
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

export default function ScheduleCMappingPanel({
    accounts,
    mappings,
    lineOptions,
    saving,
    onSave,
}: ScheduleCMappingPanelProps) {
    const isMobile = useIsMobile();
    const [search, setSearch] = useState('');
    const [showOnlyOverridden, setShowOnlyOverridden] = useState(false);
    /** Pending local edits: line string, or null for "unmap" (back to auto). */
    const [pending, setPending] = useState<Record<string, string | null>>({});

    const labelByLine = useMemo(() => {
        const m = new Map<string, string>();
        for (const o of lineOptions) m.set(o.line, o.label);
        return m;
    }, [lineOptions]);

    /** The override currently in effect for a guid ('' = no override / auto). */
    const effectiveOverride = (guid: string): string => {
        if (guid in pending) return pending[guid] ?? '';
        return mappings[guid] ?? '';
    };

    /** The line an account actually lands on: override, else keyword, else 27a. */
    const landingLine = (a: ScheduleCMappingAccount): string =>
        effectiveOverride(a.guid) || a.keywordLine || '27a';

    const setLine = (guid: string, line: string) => {
        setPending((prev) => {
            const next = { ...prev };
            const original = mappings[guid] ?? '';
            const value = line === '' ? null : line;
            if ((value ?? '') === original) delete next[guid];
            else next[guid] = value;
            return next;
        });
    };

    const visibleAccounts = useMemo(() => {
        const term = search.trim().toLowerCase();
        return accounts.filter((a) => {
            if (term && !a.fullname.toLowerCase().includes(term)) return false;
            if (showOnlyOverridden && !effectiveOverride(a.guid)) return false;
            return true;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [accounts, search, showOnlyOverridden, pending, mappings]);

    const overriddenCount = useMemo(
        () => accounts.filter((a) => effectiveOverride(a.guid)).length,
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [accounts, pending, mappings],
    );

    const pendingCount = Object.keys(pending).length;

    const handleSave = async () => {
        const changes = Object.entries(pending).map(([accountGuid, line]) => ({
            accountGuid,
            line,
        }));
        if (changes.length === 0) return;
        await onSave(changes);
        setPending({});
    };

    const lineTag = (line: string) => (
        <span className="font-mono text-foreground" style={TNUM}>
            {line}
            <span className="text-foreground-muted"> · {labelByLine.get(line) ?? line}</span>
        </span>
    );

    return (
        <div className="space-y-3">
            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-3">
                <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search expense accounts..."
                    className="flex-1 min-w-[200px] bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:border-primary"
                />
                <label className="flex items-center gap-2 text-xs text-foreground-secondary cursor-pointer">
                    <input
                        type="checkbox"
                        checked={showOnlyOverridden}
                        onChange={(e) => setShowOnlyOverridden(e.target.checked)}
                        className="accent-[var(--primary)]"
                    />
                    Overridden only
                </label>
                <span className="text-xs text-foreground-muted">
                    {overriddenCount} account{overriddenCount === 1 ? '' : 's'} overridden
                </span>
                <button
                    onClick={handleSave}
                    disabled={pendingCount === 0 || saving}
                    className="text-xs font-medium px-3 py-1.5 rounded-md bg-primary text-primary-foreground disabled:opacity-40 hover:bg-primary-hover transition-colors"
                >
                    {saving
                        ? 'Saving…'
                        : pendingCount > 0
                          ? `Save ${pendingCount} change${pendingCount === 1 ? '' : 's'}`
                          : 'Saved'}
                </button>
            </div>

            {/* Account list */}
            <div className="border border-border rounded-md overflow-hidden max-h-[480px] overflow-y-auto">
                {isMobile ? (
                    <div>
                        {visibleAccounts.map((a) => {
                            const override = effectiveOverride(a.guid);
                            const dirty = a.guid in pending;
                            return (
                                <MobileCard
                                    key={a.guid}
                                    fields={[
                                        {
                                            label: 'Account',
                                            value: (
                                                <span className="font-medium">
                                                    {a.name}
                                                    {dirty && (
                                                        <span className="ml-1.5 align-middle text-[10px] uppercase font-normal text-warning border border-warning/40 rounded px-1 py-px">
                                                            edited
                                                        </span>
                                                    )}
                                                </span>
                                            ),
                                        },
                                        {
                                            label: 'Path',
                                            value: (
                                                <span
                                                    className="block text-[11px] text-foreground-muted truncate max-w-[220px]"
                                                    title={a.fullname}
                                                >
                                                    {a.fullname}
                                                </span>
                                            ),
                                        },
                                        {
                                            label: 'Line',
                                            value: lineTag(landingLine(a)),
                                        },
                                    ]}
                                >
                                    <div className="mt-2 space-y-1.5">
                                        <LineSelect
                                            value={override}
                                            options={lineOptions}
                                            onChange={(v) => setLine(a.guid, v)}
                                            className={`w-full ${dirty ? 'border-primary' : ''}`}
                                        />
                                        {!override && (
                                            <p className="text-[11px] text-foreground-muted">
                                                Auto:{' '}
                                                {a.keywordLine
                                                    ? `${a.keywordLine} · ${labelByLine.get(a.keywordLine) ?? ''}`
                                                    : '27a · Other expenses (no keyword match)'}
                                            </p>
                                        )}
                                    </div>
                                </MobileCard>
                            );
                        })}
                        {visibleAccounts.length === 0 && (
                            <div className="px-3 py-6 text-center text-sm text-foreground-muted">
                                No accounts match.
                            </div>
                        )}
                    </div>
                ) : (
                    <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-background-tertiary">
                            <tr className="text-left text-xs text-foreground-muted">
                                <th className="px-3 py-2 font-medium">Account</th>
                                <th className="px-3 py-2 font-medium w-44">Current line</th>
                                <th className="px-3 py-2 font-medium w-64">Schedule C line</th>
                            </tr>
                        </thead>
                        <tbody>
                            {visibleAccounts.map((a) => {
                                const override = effectiveOverride(a.guid);
                                const dirty = a.guid in pending;
                                return (
                                    <tr
                                        key={a.guid}
                                        className="border-t border-border hover:bg-surface-hover"
                                    >
                                        <td className="px-3 py-1.5">
                                            <div className="text-foreground text-xs">{a.name}</div>
                                            <div className="text-[11px] text-foreground-muted truncate max-w-md">
                                                {a.fullname}
                                            </div>
                                        </td>
                                        <td className="px-3 py-1.5 text-xs">
                                            {lineTag(landingLine(a))}
                                            {dirty && (
                                                <span className="ml-1.5 text-[10px] uppercase text-warning">
                                                    edited
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-3 py-1.5">
                                            <LineSelect
                                                value={override}
                                                options={lineOptions}
                                                onChange={(v) => setLine(a.guid, v)}
                                                className={dirty ? 'border-primary' : ''}
                                            />
                                            {!override && (
                                                <span
                                                    className="ml-2 text-[11px] text-foreground-muted font-mono"
                                                    style={TNUM}
                                                    title={
                                                        a.keywordLine
                                                            ? 'Keyword suggestion'
                                                            : 'No keyword match — falls to 27a'
                                                    }
                                                >
                                                    auto → {a.keywordLine ?? '27a'}
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                            {visibleAccounts.length === 0 && (
                                <tr>
                                    <td
                                        colSpan={3}
                                        className="px-3 py-6 text-center text-sm text-foreground-muted"
                                    >
                                        No accounts match.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                )}
            </div>
            <p className="text-[11px] text-foreground-muted">
                A manual line wins over the keyword guess. Leave an account on{' '}
                <span className="text-foreground-secondary">Auto (keyword)</span> to keep the
                automatic mapping — unmatched accounts fall to line 27a &ldquo;Other expenses&rdquo;.
            </p>
        </div>
    );
}
