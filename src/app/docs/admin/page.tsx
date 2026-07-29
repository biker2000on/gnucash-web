import Link from 'next/link';
import type { Metadata } from 'next';
import { ADMIN_PAGES } from '@/lib/docs-reference';

export const metadata: Metadata = {
  title: 'Administration — GnuCash Web Docs',
  description: 'Install, secure, back up, connect, automate, upgrade, and recover GnuCash Web.',
};

export default function AdministrationIndexPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <header className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Administration</p>
        <h1 className="mt-4 text-4xl font-bold tracking-tight text-foreground">
          Keep the whole financial system recoverable.
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-foreground-secondary">
          Operational guidance for the app, worker, database, storage, identity, integrations, and
          automation surfaces.
        </p>
      </header>
      <div className="mt-12 divide-y divide-border rounded-lg border border-border bg-surface">
        {ADMIN_PAGES.map((page) => (
          <Link
            key={page.slug}
            href={`/docs/admin/${page.slug}`}
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
