import Link from 'next/link';
import type { ReactNode } from 'react';
import packageJson from '../../../package.json';
import { BrandLockup } from '@/components/brand/BrandLockup';
import { DocsSearch } from '@/components/docs/DocsSearch';
import { GUIDE_PAGES } from '@/lib/docs-content';
import { allDocsSearchEntries } from '@/lib/docs-reference';

export default function DocsLayout({ children }: { children: ReactNode }) {
  const entries = allDocsSearchEntries();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-5 px-4 sm:px-6">
          <Link href="/" className="flex shrink-0 items-center gap-2.5">
            <BrandLockup size={32} />
            <span className="hidden font-bold tracking-tight text-foreground sm:inline">
              Docs
            </span>
          </Link>
          <div className="hidden min-w-0 flex-1 md:block">
            <DocsSearch entries={entries} compact />
          </div>
          <nav className="ml-auto flex shrink-0 items-center gap-1 text-sm">
            <Link href="/features" className="hidden rounded-md px-3 py-2 text-foreground-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-foreground sm:block">
              Features
            </Link>
            <Link href="/docs/api" className="hidden rounded-md px-3 py-2 text-foreground-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-foreground sm:block">
              API
            </Link>
            <Link href="/login" className="rounded-md bg-primary px-3 py-2 font-semibold text-primary-foreground transition-colors duration-150 hover:bg-primary-hover">
              Open app
            </Link>
          </nav>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1400px] lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="border-b border-border bg-background-secondary px-4 py-5 lg:min-h-[calc(100vh-4rem)] lg:border-b-0 lg:border-r lg:px-5 lg:py-8">
          <div className="mb-5 md:hidden">
            <DocsSearch entries={entries} />
          </div>
          <nav className="grid gap-6 sm:grid-cols-3 lg:grid-cols-1">
            <div>
              <div className="px-2 text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                Start here
              </div>
              <div className="mt-2 space-y-1">
                <Link href="/docs" className="block rounded-md px-2 py-2 text-sm text-foreground-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-foreground">
                  Documentation home
                </Link>
                <Link href="/docs/getting-started" className="block rounded-md px-2 py-2 text-sm text-foreground-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-foreground">
                  Getting started
                </Link>
              </div>
            </div>
            <div>
              <div className="px-2 text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                Core workflows
              </div>
              <div className="mt-2 space-y-1">
                {GUIDE_PAGES.map((guide) => (
                  <Link
                    key={guide.slug}
                    href={`/docs/guides/${guide.slug}`}
                    className="block rounded-md px-2 py-2 text-sm leading-snug text-foreground-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-foreground"
                  >
                    {guide.title.replace(/^How to /, '')}
                  </Link>
                ))}
              </div>
            </div>
            <div>
              <div className="px-2 text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                Learn the system
              </div>
              <div className="mt-2 space-y-1">
                <Link href="/docs/concepts" className="block rounded-md px-2 py-2 text-sm text-foreground-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-foreground">
                  Financial concepts
                </Link>
                <Link href="/docs/admin" className="block rounded-md px-2 py-2 text-sm text-foreground-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-foreground">
                  Administration
                </Link>
              </div>
            </div>
            <div>
              <div className="px-2 text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                Reference
              </div>
              <div className="mt-2 space-y-1">
                <Link href="/docs/features" className="block rounded-md px-2 py-2 text-sm text-foreground-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-foreground">
                  All feature guides
                </Link>
                <Link href="/docs/api" className="block rounded-md px-2 py-2 text-sm text-foreground-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-foreground">
                  API reference
                </Link>
              </div>
            </div>
          </nav>
          <p className="mt-8 px-2 font-mono text-[10px] text-foreground-muted">
            Documentation for v{packageJson.version}
          </p>
        </aside>
        <main className="min-w-0 px-5 py-10 sm:px-8 lg:px-12 lg:py-14">{children}</main>
      </div>
    </div>
  );
}
