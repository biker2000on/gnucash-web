'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  COMPLIANCE_SEVERITY_LABELS,
  ENTITY_RULESET_LABELS,
  type ComplianceItemWithStatus,
  type ComplianceSeverity,
  type ComplianceStatus,
} from '@/lib/compliance';

const MONO = { fontFeatureSettings: "'tnum'" } as const;

interface CalendarResponse {
  year: number;
  today: string;
  entity: {
    entityType: string;
    entityName: string | null;
    taxState: string | null;
  };
  items: ComplianceItemWithStatus[];
}

const SEVERITY_CHIP_CLASS: Record<ComplianceSeverity, string> = {
  filing: 'text-secondary border-secondary/40 bg-secondary-light',
  payment: 'text-warning border-warning/40 bg-warning/10',
  admin: 'text-foreground-secondary border-border bg-background-tertiary',
};

const STATUS_CHIP_CLASS: Record<ComplianceStatus, string> = {
  pending: 'text-foreground-secondary border-border',
  done: 'text-positive border-positive/40 bg-positive/10',
  dismissed: 'text-foreground-muted border-border bg-background-tertiary',
};

function formatDue(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function daysBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

function relativeLabel(today: string, dueDate: string): string {
  const days = daysBetween(today, dueDate);
  if (days === 0) return 'due today';
  if (days < 0) return `${-days} day${days === -1 ? '' : 's'} overdue`;
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

function ItemRow({
  item,
  today,
  busy,
  onSetStatus,
}: {
  item: ComplianceItemWithStatus;
  today: string;
  busy: boolean;
  onSetStatus: (item: ComplianceItemWithStatus, status: ComplianceStatus | null) => void;
}) {
  const overdue = item.status === 'pending' && item.dueDate < today;
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-border/60 py-3 last:border-0">
      <div className="w-28 shrink-0">
        <div
          className={`font-mono text-sm ${overdue ? 'text-negative' : 'text-foreground'}`}
          style={MONO}
        >
          {formatDue(item.dueDate)}
        </div>
        <div className={`text-[11px] ${overdue ? 'text-negative' : 'text-foreground-muted'}`}>
          {relativeLabel(today, item.dueDate)}
        </div>
      </div>
      <div className="flex-1 min-w-[240px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-sm font-medium ${item.status === 'dismissed' ? 'text-foreground-muted line-through' : 'text-foreground'}`}>
            {item.title}
          </span>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${SEVERITY_CHIP_CLASS[item.severity]}`}>
            {COMPLIANCE_SEVERITY_LABELS[item.severity]}
          </span>
          {item.status !== 'pending' && (
            <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${STATUS_CHIP_CLASS[item.status]}`}>
              {item.status === 'done' ? 'Done' : 'Dismissed'}
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-foreground-muted max-w-[720px]">{item.description}</p>
        {item.href && (
          <Link
            href={item.href}
            className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:text-primary-hover transition-colors"
          >
            Open related tool <span aria-hidden>&rarr;</span>
          </Link>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {item.status === 'pending' ? (
          <>
            <button
              onClick={() => onSetStatus(item, 'done')}
              disabled={busy}
              className="rounded-md border border-positive/40 px-2.5 py-1 text-xs text-positive hover:bg-positive/10 transition-colors disabled:opacity-50"
            >
              Mark done
            </button>
            <button
              onClick={() => onSetStatus(item, 'dismissed')}
              disabled={busy}
              className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors disabled:opacity-50"
            >
              Dismiss
            </button>
          </>
        ) : (
          <button
            onClick={() => onSetStatus(item, null)}
            disabled={busy}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors disabled:opacity-50"
          >
            Reopen
          </button>
        )}
      </div>
    </div>
  );
}

function Group({
  title,
  tone,
  items,
  today,
  busyKey,
  onSetStatus,
}: {
  title: string;
  tone?: 'negative';
  items: ComplianceItemWithStatus[];
  today: string;
  busyKey: string | null;
  onSetStatus: (item: ComplianceItemWithStatus, status: ComplianceStatus | null) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="rounded-lg border border-border bg-surface/30 p-5">
      <h2 className={`text-sm font-semibold uppercase tracking-wide ${tone === 'negative' ? 'text-negative' : 'text-foreground-secondary'}`}>
        {title}
        <span className="ml-2 font-mono text-xs text-foreground-muted" style={MONO}>
          {items.length}
        </span>
      </h2>
      <div className="mt-2">
        {items.map(item => (
          <ItemRow
            key={`${item.key}|${item.period}`}
            item={item}
            today={today}
            busy={busyKey === `${item.key}|${item.period}`}
            onSetStatus={onSetStatus}
          />
        ))}
      </div>
    </section>
  );
}

export default function ComplianceCalendarPage() {
  const currentYear = new Date().getFullYear();
  // null = default view: current year + a ~3-month lookahead into next year.
  const [year, setYear] = useState<number | null>(null);
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = year !== null ? `?year=${year}` : '';
      const res = await fetch(`/api/compliance${qs}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? 'Failed to load compliance calendar');
      }
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    void load();
  }, [load]);

  const setStatus = async (item: ComplianceItemWithStatus, status: ComplianceStatus | null) => {
    const rowKey = `${item.key}|${item.period}`;
    setBusyKey(rowKey);
    try {
      const res = await fetch('/api/compliance', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemKey: item.key, period: item.period, status }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? 'Update failed');
      }
      setData(prev =>
        prev
          ? {
              ...prev,
              items: prev.items.map(i =>
                i.key === item.key && i.period === item.period
                  ? {
                      ...i,
                      status: status ?? 'pending',
                      completedAt: status ? new Date().toISOString() : null,
                    }
                  : i,
              ),
            }
          : prev,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status');
    } finally {
      setBusyKey(null);
    }
  };

  const groups = useMemo(() => {
    if (!data) return null;
    const today = data.today;
    const soon = (() => {
      const [y, m, d] = today.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d + 30));
      return dt.toISOString().slice(0, 10);
    })();

    const overdue: ComplianceItemWithStatus[] = [];
    const next30: ComplianceItemWithStatus[] = [];
    const later: ComplianceItemWithStatus[] = [];
    const resolved: ComplianceItemWithStatus[] = [];

    for (const item of data.items) {
      if (item.dueDate < today) {
        (item.status === 'pending' ? overdue : resolved).push(item);
      } else if (item.dueDate <= soon) {
        next30.push(item);
      } else {
        later.push(item);
      }
    }
    return { overdue, next30, later, resolved };
  }, [data]);

  const entityLabel = data
    ? ENTITY_RULESET_LABELS[data.entity.entityType as keyof typeof ENTITY_RULESET_LABELS] ??
      data.entity.entityType
    : null;

  return (
    <div className="space-y-6 max-w-[1100px]">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Compliance Calendar</h1>
          <p className="text-foreground-muted mt-1 text-sm">
            Every filing, payment, and administrative deadline this book&apos;s entity type owes,
            with done/dismissed tracking per period.
          </p>
          {data && (
            <p className="mt-2 text-xs text-foreground-secondary">
              Rule set:{' '}
              <span className="text-foreground font-medium">{entityLabel}</span>
              {data.entity.taxState && (
                <>
                  {' '}&middot; State: <span className="text-foreground font-medium">{data.entity.taxState}</span>
                </>
              )}
              {data.entity.entityName && (
                <>
                  {' '}&middot; <span className="text-foreground font-medium">{data.entity.entityName}</span>
                </>
              )}
            </p>
          )}
        </div>
        <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
          Year
          <select
            value={year === null ? 'default' : String(year)}
            onChange={e =>
              setYear(e.target.value === 'default' ? null : parseInt(e.target.value, 10))
            }
            className="bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
          >
            <option value="default">Current ({currentYear} + lookahead)</option>
            {[currentYear - 1, currentYear, currentYear + 1].map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </label>
      </header>

      {loading && !data && (
        <div className="flex items-center justify-center min-h-[200px] text-foreground-muted text-sm">
          Loading compliance calendar…
        </div>
      )}

      {error && (
        <div className="bg-error/10 border border-error/30 rounded-lg p-4 text-sm text-error">
          {error}
        </div>
      )}

      {data && groups && (
        <>
          <Group title="Overdue" tone="negative" items={groups.overdue} today={data.today} busyKey={busyKey} onSetStatus={setStatus} />
          <Group title="Next 30 days" items={groups.next30} today={data.today} busyKey={busyKey} onSetStatus={setStatus} />
          <Group title="Later" items={groups.later} today={data.today} busyKey={busyKey} onSetStatus={setStatus} />
          <Group title="Resolved earlier" items={groups.resolved} today={data.today} busyKey={busyKey} onSetStatus={setStatus} />

          {data.items.length === 0 && (
            <div className="rounded-lg border border-border bg-surface/30 p-6 text-sm text-foreground-secondary">
              No compliance items for this entity type and year.
            </div>
          )}

          <p className="text-xs text-foreground-muted">
            Weekend due dates are noted per item — the effective deadline moves to the next
            business day. Deadlines within 14 days also raise in-app notifications, and pending
            items can be exported to your calendar app via Settings &rarr; Calendar feeds.
          </p>
        </>
      )}
    </div>
  );
}
