import Link from 'next/link';
import type { DocPage } from '@/lib/docs-content';

const KIND_LABEL: Record<DocPage['kind'], string> = {
  tutorial: 'Tutorial',
  guide: 'How-to guide',
  concept: 'Explanation',
  admin: 'Administration',
  reference: 'Reference',
};

export function DocsArticle({ page }: { page: DocPage }) {
  return (
    <article className="mx-auto max-w-3xl">
      <nav className="mb-8 flex items-center gap-2 text-xs text-foreground-muted">
        <Link href="/docs" className="transition-colors duration-150 hover:text-primary">
          Docs
        </Link>
        <span aria-hidden>/</span>
        <span>{KIND_LABEL[page.kind]}</span>
      </nav>

      <header className="border-b border-border pb-8">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
            {KIND_LABEL[page.kind]}
          </span>
          <span className="text-xs text-foreground-muted">{page.readTime}</span>
        </div>
        <h1 className="mt-4 text-3xl font-bold tracking-tight text-foreground lg:text-4xl">
          {page.title}
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-foreground-secondary">{page.summary}</p>
      </header>

      <div className="space-y-12 py-10">
        {page.sections.map((section) => (
          <section key={section.heading} className="scroll-mt-24">
            <h2 className="text-xl font-semibold text-foreground">{section.heading}</h2>
            {section.paragraphs?.map((paragraph) => (
              <p key={paragraph} className="mt-4 leading-7 text-foreground-secondary">
                {paragraph}
              </p>
            ))}
            {section.steps && (
              <ol className="mt-5 space-y-4">
                {section.steps.map((step, index) => (
                  <li key={step} className="flex gap-4">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-primary/40 bg-primary-light font-mono text-xs font-semibold text-primary">
                      {index + 1}
                    </span>
                    <p className="pt-0.5 leading-7 text-foreground-secondary">{step}</p>
                  </li>
                ))}
              </ol>
            )}
            {section.bullets && (
              <ul className="mt-5 space-y-3">
                {section.bullets.map((bullet) => (
                  <li key={bullet} className="flex gap-3 leading-7 text-foreground-secondary">
                    <span className="mt-3 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      <footer className="border-t border-border py-8">
        <div className="flex flex-wrap gap-3">
          <Link
            href="/docs"
            className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground-secondary transition-colors duration-150 hover:border-border-hover hover:text-foreground"
          >
            Back to documentation
          </Link>
          <Link
            href="/docs/features"
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors duration-150 hover:bg-primary-hover"
          >
            Browse feature reference
          </Link>
        </div>
      </footer>
    </article>
  );
}
