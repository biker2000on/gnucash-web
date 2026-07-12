import Link from 'next/link';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { FEATURE_PAGES } from '@/lib/marketing-content';

export function generateStaticParams() {
    return FEATURE_PAGES.map(page => ({ slug: page.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
    const { slug } = await params;
    const page = FEATURE_PAGES.find(p => p.slug === slug);
    if (!page) return {};
    return {
        title: `${page.navLabel} — GnuCash Web`,
        description: page.tagline,
    };
}

export default async function FeaturePage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const page = FEATURE_PAGES.find(p => p.slug === slug);
    if (!page) notFound();

    const pageIndex = FEATURE_PAGES.findIndex(p => p.slug === slug);
    const nextPage = FEATURE_PAGES[(pageIndex + 1) % FEATURE_PAGES.length];

    return (
        <>
            {/* Hero banner */}
            <section className="relative overflow-hidden border-b border-border">
                <Image
                    src={page.heroImage}
                    alt={page.heroAlt}
                    fill
                    priority
                    className="object-cover"
                    sizes="100vw"
                />
                <div className="absolute inset-0 bg-background/85" aria-hidden />
                <div className="relative max-w-7xl mx-auto px-6 pt-20 pb-16 lg:pt-28 lg:pb-24">
                    <p className="text-xs uppercase tracking-[0.2em] text-primary font-semibold mb-4">
                        {page.navLabel}
                    </p>
                    <h1 className="max-w-3xl text-3xl lg:text-5xl font-bold text-foreground leading-[1.1] tracking-tight">
                        {page.title}
                    </h1>
                    <p className="max-w-2xl mt-5 text-lg text-foreground-secondary leading-relaxed">{page.tagline}</p>
                    <div className="mt-8">
                        <Link
                            href="/login"
                            className="px-6 py-3 text-sm font-semibold bg-primary hover:bg-primary-hover text-primary-foreground rounded-md transition-colors duration-150"
                        >
                            Open your books
                        </Link>
                    </div>
                </div>
            </section>

            {/* Capability sections */}
            {page.sections.map((section, i) => (
                <section key={section.heading} className={i % 2 === 1 ? 'border-y border-border bg-background-secondary' : ''}>
                    <div className="max-w-7xl mx-auto px-6 py-16 lg:py-20">
                        <div className="max-w-2xl mb-10">
                            <h2 className="text-2xl lg:text-3xl font-bold text-foreground tracking-tight">{section.heading}</h2>
                            <p className="mt-3 text-foreground-secondary leading-relaxed">{section.lead}</p>
                        </div>
                        <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
                            {section.items.map(item => (
                                <div key={item.name} className="border-l-2 border-primary/50 pl-4">
                                    <h3 className="text-sm font-semibold text-foreground">{item.name}</h3>
                                    <p className="mt-1.5 text-sm text-foreground-muted leading-relaxed">{item.description}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                </section>
            ))}

            {/* Next page + CTA */}
            <section className="max-w-7xl mx-auto px-6 py-16">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 bg-surface border border-border rounded-lg px-8 py-8">
                    <div>
                        <div className="text-[11px] uppercase tracking-wider text-foreground-muted font-semibold mb-1.5">
                            Keep exploring
                        </div>
                        <Link
                            href={`/features/${nextPage.slug}`}
                            className="text-lg font-semibold text-foreground hover:text-primary transition-colors duration-150 inline-flex items-center gap-2"
                        >
                            {nextPage.navLabel}
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12l-7.5 7.5M21 12H3" />
                            </svg>
                        </Link>
                    </div>
                    <Link
                        href="/login"
                        className="px-6 py-3 text-sm font-semibold bg-primary hover:bg-primary-hover text-primary-foreground rounded-md transition-colors duration-150 shrink-0"
                    >
                        Sign in
                    </Link>
                </div>
            </section>
        </>
    );
}
