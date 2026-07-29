import Link from 'next/link';
import type { Metadata } from 'next';
import { DocsSearch } from '@/components/docs/DocsSearch';
import { GUIDE_PAGES } from '@/lib/docs-content';
import { allDocsSearchEntries } from '@/lib/docs-reference';
import { product } from '@/lib/product';

export const metadata: Metadata = {
  title: `Documentation — ${product.brand}`,
  description: `Learn how to set up, operate, and understand every part of ${product.brand}.`,
};

const PATHS = [
  {
    title: 'Keep trustworthy books',
    description: 'Capture activity, attach evidence, reconcile statements, and close each period.',
    href: '/docs/guides/reconcile-a-statement',
  },
  {
    title: 'Make better decisions',
    description: 'Use the Action Center, scenarios, Living Plan, and Money Timeline together.',
    href: '/docs/guides/living-plan-and-timeline',
  },
  {
    title: 'Run a business',
    description: 'Follow work through estimates, jobs, invoices, payments, costs, and close.',
    href: '/docs/guides/business-cash-cycle',
  },
  {
    title: 'Coordinate a family office',
    description: 'Consolidate authorized books without hiding ownership, currency, or evidence.',
    href: '/docs/guides/family-office',
  },
];

export default function DocumentationHome() {
  const entries = allDocsSearchEntries();

  return (
    <div className="mx-auto max-w-5xl">
      <header className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Documentation</p>
        <h1 className="mt-4 text-4xl font-bold tracking-tight text-foreground lg:text-5xl">
          Know what every number means—and what to do next.
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-foreground-secondary">
          Start with a working book, learn the recurring workflows, then go as deep as your household,
          investments, taxes, or business require.
        </p>
        <div className="mt-8">
          <DocsSearch entries={entries} />
        </div>
      </header>

      <section className="mt-16 grid gap-4 md:grid-cols-2">
        <Link
          href="/docs/getting-started"
          className="rounded-lg border border-primary/40 bg-primary-light p-6 transition-colors duration-150 hover:border-primary"
        >
          <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">First tutorial</div>
          <h2 className="mt-2 text-xl font-semibold text-foreground">Get from a book to a weekly review</h2>
          <p className="mt-2 text-sm leading-relaxed text-foreground-secondary">
            Create or import a book, verify activity, attach evidence, and complete the first review.
          </p>
        </Link>
        <Link
          href="/docs/features"
          className="rounded-lg border border-border bg-surface p-6 transition-colors duration-150 hover:border-border-hover"
        >
          <div className="text-[11px] font-semibold uppercase tracking-wider text-foreground-muted">Reference</div>
          <h2 className="mt-2 text-xl font-semibold text-foreground">Browse every feature guide</h2>
          <p className="mt-2 text-sm leading-relaxed text-foreground-secondary">
            Purpose, prerequisites, permissions, operation, and verification for every registered capability.
          </p>
        </Link>
      </section>

      <section className="mt-16 grid gap-4 md:grid-cols-2">
        <Link
          href="/docs/concepts"
          className="rounded-lg border border-border bg-surface p-6 transition-colors duration-150 hover:border-primary/60"
        >
          <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">Understand</div>
          <h2 className="mt-2 text-xl font-semibold text-foreground">Financial and system concepts</h2>
          <p className="mt-2 text-sm leading-relaxed text-foreground-secondary">
            Double-entry, cost basis, reconciliation, provenance, roles, and multi-book consolidation.
          </p>
        </Link>
        <Link
          href="/docs/admin"
          className="rounded-lg border border-border bg-surface p-6 transition-colors duration-150 hover:border-primary/60"
        >
          <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">Operate</div>
          <h2 className="mt-2 text-xl font-semibold text-foreground">Administration and recovery</h2>
          <p className="mt-2 text-sm leading-relaxed text-foreground-secondary">
            Install, upgrade, secure, back up, connect, automate, and recover the complete stack.
          </p>
        </Link>
      </section>

      <section className="mt-16">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-foreground-muted">Choose an outcome</p>
          <h2 className="mt-2 text-2xl font-bold text-foreground">Learn by the job you need to finish</h2>
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {PATHS.map((path) => (
            <Link key={path.href} href={path.href} className="rounded-lg border border-border bg-surface p-5 transition-colors duration-150 hover:border-primary/60">
              <h3 className="font-semibold text-foreground">{path.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-foreground-muted">{path.description}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="mt-16 border-t border-border pt-12">
        <h2 className="text-2xl font-bold text-foreground">Core how-to guides</h2>
        <div className="mt-6 divide-y divide-border rounded-lg border border-border bg-surface">
          {GUIDE_PAGES.map((guide) => (
            <Link
              key={guide.slug}
              href={`/docs/guides/${guide.slug}`}
              className="flex flex-col gap-2 px-5 py-4 transition-colors duration-150 hover:bg-surface-hover sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <h3 className="font-medium text-foreground">{guide.title}</h3>
                <p className="mt-1 text-sm text-foreground-muted">{guide.summary}</p>
              </div>
              <span className="shrink-0 font-mono text-xs text-foreground-muted">{guide.readTime}</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
