'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/format';

const MONO = { fontFeatureSettings: "'tnum'" } as const;

const IRS_990N_URL =
  'https://www.irs.gov/charities-non-profits/annual-electronic-filing-requirement-for-small-exempt-organizations-form-990-n-e-postcard';

const ENTITY_TYPE_LABELS: Record<string, string> = {
  household: 'household',
  sole_prop: 'sole proprietorship',
  llc_single: 'single-member LLC',
  llc_partnership: 'partnership LLC',
  s_corp: 'S-Corp',
  c_corp: 'C-Corp',
  nonprofit_501c3: '501(c)(3) nonprofit',
};

interface Form990Response {
  applicable: true;
  year: number;
  fiscalYearStart: string;
  fiscalYearEnd: string;
  grossReceipts: number;
  threshold: number;
  qualifiesFor990N: boolean;
  dueDate: string;
  checklist: {
    ein: string | null;
    taxYear: number;
    legalName: string | null;
    mailingAddress: string | null;
    otherNames: string | null;
    principalOfficer: string | null;
    website: string | null;
    grossReceiptsUnder50k: boolean;
    terminated: boolean;
  };
}

interface NotApplicableResponse {
  applicable: false;
  entityType: string;
}

function formatDue(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function ChecklistRow({
  index,
  label,
  value,
  hint,
}: {
  index: number;
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-border/60 py-2.5 last:border-0">
      <span className="mt-0.5 w-5 shrink-0 text-right font-mono text-xs text-foreground-muted" style={MONO}>
        {index}.
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-foreground-muted">{hint}</p>}
      </div>
      <div className="shrink-0 text-sm text-right max-w-[45%]">{value}</div>
    </div>
  );
}

function Prefilled({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-foreground">{children}</span>;
}

function NotKnown({ children = 'enter when filing' }: { children?: React.ReactNode }) {
  return <span className="text-xs text-foreground-muted italic">{children}</span>;
}

export default function Form990Page() {
  const [year, setYear] = useState<number | null>(null);
  const [data, setData] = useState<Form990Response | null>(null);
  const [notApplicable, setNotApplicable] = useState<NotApplicableResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = year !== null ? `?year=${year}` : '';
    fetch(`/api/business/990${qs}`)
      .then(async res => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? 'Failed to load 990-N data');
        }
        return (await res.json()) as Form990Response | NotApplicableResponse;
      })
      .then(payload => {
        if (cancelled) return;
        if (!payload.applicable) {
          setNotApplicable(payload);
          return;
        }
        setData(payload);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [year]);

  if (notApplicable) {
    const entityLabel = ENTITY_TYPE_LABELS[notApplicable.entityType] ?? notApplicable.entityType;
    return (
      <div className="space-y-6 max-w-[900px]">
        <header>
          <h1 className="text-3xl font-bold text-foreground">Form 990-N Helper</h1>
          <p className="text-foreground-muted mt-1 text-sm">
            Gross-receipts test and e-Postcard checklist for small exempt organizations.
          </p>
        </header>
        <div className="rounded-lg border border-border bg-surface/30 p-6 space-y-3">
          <p className="text-sm text-foreground-secondary">
            The 990-N helper applies to 501(c)(3) nonprofit books. This book is a {entityLabel},
            so the annual exempt-organization filing doesn&apos;t apply here.
          </p>
          <Link
            href="/taxes/compliance"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary-hover transition-colors"
          >
            See this entity&apos;s compliance calendar
            <span aria-hidden>&rarr;</span>
          </Link>
        </div>
      </div>
    );
  }

  const lastCompletedYear = new Date().getFullYear() - 1;
  const yearChoices = [lastCompletedYear - 2, lastCompletedYear - 1, lastCompletedYear, lastCompletedYear + 1];

  return (
    <div className="space-y-6 max-w-[900px]">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Form 990-N Helper</h1>
          <p className="text-foreground-muted mt-1 text-sm">
            Checks the $50,000 gross-receipts test from this book&apos;s income accounts and
            prefills what it can for the IRS e-Postcard.
          </p>
        </div>
        <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
          Fiscal year
          <select
            value={year ?? data?.year ?? lastCompletedYear}
            onChange={e => setYear(parseInt(e.target.value, 10))}
            className="bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
          >
            {yearChoices.map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </label>
      </header>

      {loading && !data && (
        <div className="flex items-center justify-center min-h-[200px] text-foreground-muted text-sm">
          Loading 990-N data…
        </div>
      )}

      {error && (
        <div className="bg-error/10 border border-error/30 rounded-lg p-4 text-sm text-error">{error}</div>
      )}

      {data && !error && (
        <>
          {/* Gross-receipts test */}
          <section
            className={`rounded-lg border p-6 ${
              data.qualifiesFor990N ? 'border-positive/40 bg-positive/5' : 'border-warning/40 bg-warning/5'
            }`}
          >
            <p className="text-xs uppercase tracking-wider text-foreground-muted">
              Gross receipts — FY {data.year}
            </p>
            <p
              className={`mt-1 font-mono text-3xl font-bold ${
                data.qualifiesFor990N ? 'text-positive' : 'text-warning'
              }`}
              style={MONO}
            >
              {formatCurrency(data.grossReceipts)}
            </p>
            <p className="mt-2 text-sm text-foreground-secondary">
              {data.qualifiesFor990N ? (
                <>
                  At or under the {formatCurrency(data.threshold)} threshold — the organization
                  can file the <span className="text-foreground font-medium">990-N e-Postcard</span>.
                </>
              ) : (
                <>
                  Above the {formatCurrency(data.threshold)} e-Postcard threshold — the
                  organization must file <span className="text-foreground font-medium">Form 990-EZ</span>{' '}
                  (or the full Form 990) instead of the 990-N.
                </>
              )}
            </p>
            <p className="mt-1 text-xs text-foreground-muted">
              Sum of all income-account activity {data.fiscalYearStart} through {data.fiscalYearEnd}.
              The IRS test technically averages three years for new organizations — verify if
              you&apos;re close to the line.
            </p>
          </section>

          {/* Due-date callout */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-secondary/30 bg-secondary-light px-4 py-3">
            <p className="text-sm text-foreground">
              Due <span className="font-mono font-semibold" style={MONO}>{formatDue(data.dueDate)}</span>
              <span className="text-foreground-secondary"> — the 15th day of the 5th month after fiscal year end. There is no extension for the 990-N; missing three years in a row auto-revokes exempt status.</span>
            </p>
            <a
              href={IRS_990N_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-primary/40 px-3 py-1.5 text-sm text-primary hover:text-primary-hover hover:border-primary transition-colors"
            >
              File on IRS.gov
              <span aria-hidden>&#8599;</span>
            </a>
          </div>

          {/* e-Postcard checklist */}
          <section className="rounded-lg border border-border bg-surface/30 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground-secondary">
              e-Postcard checklist — the 8 things it asks for
            </h2>
            <div className="mt-2">
              <ChecklistRow
                index={1}
                label="Employer Identification Number (EIN)"
                hint={
                  <>
                    Not stored here — have your EIN letter (CP-575) ready.{' '}
                    <Link href="/business/documents" className="text-primary hover:text-primary-hover">
                      Check the documents vault
                    </Link>
                  </>
                }
                value={<NotKnown>have your EIN letter ready</NotKnown>}
              />
              <ChecklistRow
                index={2}
                label="Tax year"
                value={<Prefilled>Calendar year {data.checklist.taxYear}</Prefilled>}
              />
              <ChecklistRow
                index={3}
                label="Legal name and mailing address"
                value={
                  data.checklist.legalName ? (
                    <span>
                      <Prefilled>{data.checklist.legalName}</Prefilled>
                      <span className="block text-xs text-foreground-muted">address: enter when filing</span>
                    </span>
                  ) : (
                    <NotKnown>set the entity name in book settings</NotKnown>
                  )
                }
              />
              <ChecklistRow
                index={4}
                label="Any other names the organization uses"
                value={<NotKnown />}
              />
              <ChecklistRow
                index={5}
                label="Name and address of a principal officer"
                value={
                  data.checklist.principalOfficer ? (
                    <Prefilled>{data.checklist.principalOfficer}</Prefilled>
                  ) : (
                    <NotKnown>add an officer member to the entity profile</NotKnown>
                  )
                }
              />
              <ChecklistRow
                index={6}
                label="Website address, if any"
                value={<NotKnown />}
              />
              <ChecklistRow
                index={7}
                label="Confirmation that gross receipts are $50,000 or less"
                value={
                  data.checklist.grossReceiptsUnder50k ? (
                    <span className="font-medium text-positive">Yes — {formatCurrency(data.grossReceipts)}</span>
                  ) : (
                    <span className="font-medium text-warning">No — file 990-EZ instead</span>
                  )
                }
              />
              <ChecklistRow
                index={8}
                label="Statement that the organization is terminating, if applicable"
                value={<NotKnown>only if going out of business</NotKnown>}
              />
            </div>
          </section>

          <p className="text-xs text-foreground-muted">
            This deadline also appears on the{' '}
            <Link href="/taxes/compliance" className="text-primary hover:text-primary-hover">
              compliance calendar
            </Link>
            , where you can mark it done for the year.
          </p>
        </>
      )}
    </div>
  );
}
