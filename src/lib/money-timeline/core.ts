import type {
  FinancialEvent,
  FinancialEventStatus,
  MoneyTimeline,
  TimelineConflict,
} from './types';

const DAY_MS = 86_400_000;

export function isoDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

export function eventStatus(
  date: string,
  needsAction: boolean,
  now: Date = new Date(),
): FinancialEventStatus {
  if (date < isoDate(now)) return 'overdue';
  return needsAction ? 'needs_action' : 'expected';
}

export function detectTimelineConflicts(
  events: FinancialEvent[],
  openingCash: number,
  minimumCash = 0,
  now: Date = new Date(),
): TimelineConflict[] {
  const conflicts: TimelineConflict[] = [];
  const today = isoDate(now);

  for (const event of events) {
    if (event.status === 'overdue' || (event.date < today && event.status !== 'complete')) {
      conflicts.push({
        id: `overdue:${event.id}`,
        kind: 'overdue',
        severity: event.cashImpact !== null && Math.abs(event.cashImpact) >= 1_000 ? 'critical' : 'warning',
        date: event.date,
        title: `Overdue: ${event.title}`,
        description: 'This dated obligation is still open after its expected date.',
        eventIds: [event.id],
      });
    }
    if (
      event.domain === 'goal'
      && event.date < today
      && event.metadata.goalType !== 'debt_payoff'
    ) {
      conflicts.push({
        id: `contribution-window:${event.id}`,
        kind: 'contribution_window',
        severity: 'warning',
        date: event.date,
        title: `Missed contribution window: ${event.title}`,
        description: 'The target date passed before the savings or contribution goal was completed.',
        eventIds: [event.id],
      });
    }
  }

  const duplicateGroups = new Map<string, FinancialEvent[]>();
  for (const event of events) {
    const key = `${event.date}|${event.title.trim().toLowerCase()}|${event.cashImpact ?? ''}`;
    const list = duplicateGroups.get(key) ?? [];
    list.push(event);
    duplicateGroups.set(key, list);
  }
  for (const group of duplicateGroups.values()) {
    if (group.length < 2) continue;
    conflicts.push({
      id: `duplicate:${group.map(e => e.id).sort().join(':')}`,
      kind: 'duplicate',
      severity: 'warning',
      date: group[0].date,
      title: `Possible duplicate: ${group[0].title}`,
      description: `${group.length} sources describe the same dated cash event. Confirm it will not be counted twice.`,
      eventIds: group.map(e => e.id),
    });
  }

  let cash = openingCash;
  let below = false;
  for (const event of [...events].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    if (event.cashImpact !== null) cash += event.cashImpact;
    if (cash < minimumCash && !below) {
      conflicts.push({
        id: `low-cash:${event.date}`,
        kind: 'low_cash',
        severity: cash < 0 ? 'critical' : 'warning',
        date: event.date,
        title: cash < 0 ? 'Projected cash shortfall' : 'Cash guardrail breached',
        description: `Known events put projected cash at ${cash.toFixed(2)}, below the ${minimumCash.toFixed(2)} guardrail.`,
        eventIds: [event.id],
        projectedCash: Math.round(cash * 100) / 100,
      });
      below = true;
    } else if (cash >= minimumCash) {
      below = false;
    }
  }

  return conflicts.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export function buildMoneyTimeline(
  events: FinancialEvent[],
  from: string,
  to: string,
  currency: string,
  openingCash: number,
  minimumCash = 0,
  now: Date = new Date(),
): MoneyTimeline {
  const filtered = events
    .filter(event => event.date >= from && event.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  const counts = new Map<FinancialEvent['domain'], number>();
  for (const event of filtered) counts.set(event.domain, (counts.get(event.domain) ?? 0) + 1);
  return {
    generatedAt: now.toISOString(),
    from,
    to,
    currency,
    openingCash: Math.round(openingCash * 100) / 100,
    events: filtered,
    conflicts: detectTimelineConflicts(filtered, openingCash, minimumCash, now),
    domains: [...counts.entries()].map(([domain, count]) => ({ domain, count })),
  };
}

export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / DAY_MS);
}
