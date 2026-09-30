'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { describeStatus, type EntityStatusRow } from '@/lib/entity-status';

interface TaxYearPayload {
  current: EntityStatusRow | null;
  taxYear: {
    year: number;
    status: EntityStatusRow | null;
    segments: Array<{ from: string; to: string; row: EntityStatusRow }>;
    mixed: boolean;
    entityType: string;
  };
}

/** Fetch the active book's entity status for tax year `year`. */
export function useEntityTaxYearStatus(year: number | null) {
  const [data, setData] = useState<TaxYearPayload | null>(null);
  useEffect(() => {
    if (year === null) return;
    let cancelled = false;
    const load = () => {
      fetch(`/api/entity/status?year=${year}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          if (!cancelled) setData(json);
        })
        .catch(() => undefined);
    };
    load();
    window.addEventListener('entity-status-updated', load);
    return () => {
      cancelled = true;
      window.removeEventListener('entity-status-updated', load);
    };
  }, [year]);
  return data?.taxYear.year === year ? data : null;
}

/**
 * Banner for pages that compute a specific tax year: says when that year's
 * entity status differs from today's (e.g. the year before an S election
 * took effect), and when the year contains a mid-year change (short tax
 * years — the page applies the year-end status). Renders nothing otherwise.
 */
export function EntityYearStatusNotice({ year }: { year: number }) {
  const data = useEntityTaxYearStatus(year);
  if (!data?.taxYear.status || !data.current) return null;
  const { taxYear, current } = data;
  const yearStatus = data.taxYear.status;

  if (taxYear.mixed) {
    return (
      <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-foreground-secondary">
        The entity&apos;s tax status changes during {year}:{' '}
        {taxYear.segments.map((s, i) => (
          <span key={s.from}>
            {i > 0 && '; then '}
            <span className="font-medium text-foreground">{describeStatus(s.row)}</span> from{' '}
            <span className="font-mono">{s.from}</span>
          </span>
        ))}
        . This page applies the year-end status to the whole year; short tax years may need
        separate returns.{' '}
        <Link href="/settings#entity-status" className="text-primary hover:underline">
          Tax status history
        </Link>
      </div>
    );
  }

  const sameAsToday =
    yearStatus.legalForm === current.legalForm &&
    yearStatus.taxClassification === current.taxClassification;
  if (sameAsToday) return null;

  return (
    <div className="rounded-lg border border-secondary/30 bg-secondary-light px-4 py-3 text-sm text-foreground-secondary">
      For tax year {year} this entity is{' '}
      <span className="font-medium text-foreground">{describeStatus(yearStatus)}</span>
      {' '}(today: {describeStatus(current)}). Figures on this page use the {year} status.{' '}
      <Link href="/settings#entity-status" className="text-primary hover:underline">
        Tax status history
      </Link>
    </div>
  );
}
