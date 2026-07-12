import Link from 'next/link';
import { FEATURE_PAGES } from '@/lib/marketing-content';

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="min-h-screen bg-background flex flex-col">
            {/* Header */}
            <header className="sticky top-0 z-50 border-b border-border bg-background/90 backdrop-blur-md">
                <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between gap-6">
                    <Link href="/" className="flex items-center gap-2.5 shrink-0">
                        {/* eslint-disable-next-line @next/next/no-img-element -- app favicon, plain svg */}
                        <img src="/icon.svg" alt="" className="w-8 h-8" />
                        <span className="text-lg font-bold text-foreground tracking-tight">GnuCash Web</span>
                    </Link>

                    <nav className="hidden md:flex items-center gap-1">
                        {FEATURE_PAGES.map(page => (
                            <Link
                                key={page.slug}
                                href={`/features/${page.slug}`}
                                className="px-3 py-2 text-sm text-foreground-secondary hover:text-foreground rounded-md hover:bg-surface-hover transition-colors duration-150"
                            >
                                {page.navLabel}
                            </Link>
                        ))}
                    </nav>

                    <div className="flex items-center gap-3 shrink-0">
                        <Link
                            href="/login"
                            className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors duration-150"
                        >
                            Sign in
                        </Link>
                        <Link
                            href="/login"
                            className="px-4 py-2 text-sm font-semibold bg-primary hover:bg-primary-hover text-primary-foreground rounded-md transition-colors duration-150"
                        >
                            Open your books
                        </Link>
                    </div>
                </div>

                {/* Mobile feature nav */}
                <nav className="md:hidden border-t border-border overflow-x-auto">
                    <div className="flex px-4 py-1.5 gap-1 w-max">
                        {FEATURE_PAGES.map(page => (
                            <Link
                                key={page.slug}
                                href={`/features/${page.slug}`}
                                className="px-3 py-1.5 text-xs whitespace-nowrap text-foreground-secondary hover:text-foreground rounded-md hover:bg-surface-hover transition-colors duration-150"
                            >
                                {page.navLabel}
                            </Link>
                        ))}
                    </div>
                </nav>
            </header>

            <main className="flex-1">{children}</main>

            {/* Footer */}
            <footer className="border-t border-border bg-background-secondary">
                <div className="max-w-7xl mx-auto px-6 py-12 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                        <div className="flex items-center gap-2.5 mb-3">
                            {/* eslint-disable-next-line @next/next/no-img-element -- app favicon, plain svg */}
                            <img src="/icon.svg" alt="" className="w-7 h-7" />
                            <span className="font-bold text-foreground">GnuCash Web</span>
                        </div>
                        <p className="text-sm text-foreground-muted leading-relaxed">
                            A self-hosted, GnuCash-compatible finance platform. Your ledger, your database, your rules.
                        </p>
                    </div>
                    <div>
                        <div className="text-[11px] uppercase tracking-wider text-foreground-muted font-semibold mb-3">Product</div>
                        <ul className="space-y-2">
                            {FEATURE_PAGES.map(page => (
                                <li key={page.slug}>
                                    <Link
                                        href={`/features/${page.slug}`}
                                        className="text-sm text-foreground-secondary hover:text-foreground transition-colors duration-150"
                                    >
                                        {page.navLabel}
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    </div>
                    <div>
                        <div className="text-[11px] uppercase tracking-wider text-foreground-muted font-semibold mb-3">Foundation</div>
                        <ul className="space-y-2 text-sm text-foreground-secondary">
                            <li>Double-entry accounting</li>
                            <li>PostgreSQL + GnuCash schema</li>
                            <li>Desktop round-trip via XML</li>
                            <li>Docker, single image</li>
                        </ul>
                    </div>
                    <div>
                        <div className="text-[11px] uppercase tracking-wider text-foreground-muted font-semibold mb-3">Get started</div>
                        <ul className="space-y-2">
                            <li>
                                <Link href="/login" className="text-sm text-foreground-secondary hover:text-foreground transition-colors duration-150">
                                    Sign in
                                </Link>
                            </li>
                            <li>
                                <a
                                    href="https://github.com/biker2000on/gnucash-web"
                                    className="text-sm text-foreground-secondary hover:text-foreground transition-colors duration-150"
                                >
                                    Source on GitHub
                                </a>
                            </li>
                            <li>
                                <a
                                    href="https://www.gnucash.org"
                                    className="text-sm text-foreground-secondary hover:text-foreground transition-colors duration-150"
                                >
                                    GnuCash desktop
                                </a>
                            </li>
                        </ul>
                    </div>
                </div>
                <div className="border-t border-border">
                    <div className="max-w-7xl mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-2 text-xs text-foreground-muted">
                        <span>Not affiliated with the GnuCash project. GnuCash is a trademark of its respective owners.</span>
                        <span className="font-mono">Photos: Unsplash</span>
                    </div>
                </div>
            </footer>
        </div>
    );
}
