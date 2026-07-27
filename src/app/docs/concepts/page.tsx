import Link from 'next/link';
import type { Metadata } from 'next';
import { CONCEPT_PAGES } from '@/lib/docs-reference';

export const metadata: Metadata = {
  title: 'Financial concepts — GnuCash Web Docs',
  description: 'The accounting, trust, investment, provenance, and multi-book concepts behind GnuCash Web.',
};

export default function ConceptsIndexPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <header className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Concepts</p>
        <h1 className="mt-4 text-4xl font-bold tracking-tight text-foreground">
          Understand the model behind the interface.
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-foreground-secondary">
          These explanations connect ledger mechanics, evidence, permissions, and consolidation so
          you can reason about results instead of memorizing screens.
        </p>
      </header>
      <div className="mt-12 divide-y divide-border rounded-lg border border-border bg-surface">
        {CONCEPT_PAGES.map((page) => (
          <Link
            key={page.slug}
            href={`/docs/concepts/${page.slug}`}
            className="block px-5 py-5 transition-colors duration-150 hover:bg-surface-hover"
          >
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="font-semibold text-foreground">{page.title}</h2>
              <span className="shrink-0 font-mono text-xs text-foreground-muted">{page.readTime}</span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-foreground-muted">{page.summary}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
