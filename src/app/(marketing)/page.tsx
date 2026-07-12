import Link from 'next/link';
import Image from 'next/image';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getPreference } from '@/lib/user-preferences';
import { PILLARS, LANDING_STATS } from '@/lib/marketing-content';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

const DEMO_ROWS = [
    { date: '07/10/2026', desc: 'Paycheck — Acme Corp', account: 'Income:Salary', amount: '+4,832.17', positive: true },
    { date: '07/09/2026', desc: 'Buy 12.402 VTSAX @ 121.44', account: 'Assets:Brokerage:VTSAX', amount: '1,506.10', positive: false },
    { date: '07/08/2026', desc: 'Mortgage — principal + interest', account: 'Liabilities:Mortgage', amount: '-2,214.90', positive: false },
    { date: '07/07/2026', desc: 'Realized Gain — Lot 7f3a21c9', account: 'Income:Capital Gains:Long Term', amount: '+139.49', positive: true },
];

export default async function LandingPage() {
    const session = await getSession();
    if (session.isLoggedIn && session.userId) {
        const homeScreen = await getPreference(session.userId, 'home_screen', 'dashboard');
        redirect(homeScreen === 'accounts' ? '/accounts' : '/dashboard');
    }

    return (
        <>
            {/* Hero */}
            <section className="relative overflow-hidden border-b border-border">
                <Image
                    src="/marketing/hero-terminal.jpg"
                    alt=""
                    fill
                    priority
                    className="object-cover"
                    sizes="100vw"
                />
                <div className="absolute inset-0 bg-background/85" aria-hidden />
                <div className="relative max-w-7xl mx-auto px-6 pt-24 pb-20 lg:pt-32 lg:pb-28">
                    <p className="text-xs uppercase tracking-[0.2em] text-primary font-semibold mb-5">
                        Self-hosted · GnuCash-compatible · Double-entry
                    </p>
                    <h1 className="max-w-3xl text-4xl lg:text-6xl font-bold text-foreground leading-[1.08] tracking-tight">
                        Your entire financial life, on a ledger you own.
                    </h1>
                    <p className="max-w-2xl mt-6 text-lg text-foreground-secondary leading-relaxed">
                        GnuCash Web turns your GnuCash book into a modern platform: bank sync, lot-level
                        investment tracking, IRS-ready tax reports, retirement planning, and small-business
                        invoicing — running on your own server, against your own PostgreSQL.
                    </p>
                    <div className="mt-9 flex flex-wrap gap-3">
                        <Link
                            href="/login"
                            className="px-6 py-3 text-sm font-semibold bg-primary hover:bg-primary-hover text-primary-foreground rounded-md transition-colors duration-150"
                        >
                            Open your books
                        </Link>
                        <Link
                            href="/features/accounting"
                            className="px-6 py-3 text-sm font-semibold border border-border hover:border-border-hover text-foreground rounded-md transition-colors duration-150 bg-background/60"
                        >
                            Explore the platform
                        </Link>
                    </div>
                </div>
            </section>

            {/* Stats band */}
            <section className="border-b border-border bg-background-secondary">
                <div className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-2 lg:grid-cols-4 gap-6">
                    {LANDING_STATS.map(stat => (
                        <div key={stat.label} className="flex items-baseline gap-3">
                            <span className="text-3xl font-bold text-foreground font-mono" style={TNUM}>
                                {stat.value}
                            </span>
                            <span className="text-sm text-foreground-muted">{stat.label}</span>
                        </div>
                    ))}
                </div>
            </section>

            {/* Pillars */}
            <section className="max-w-7xl mx-auto px-6 py-20">
                <div className="max-w-2xl mb-12">
                    <h2 className="text-3xl font-bold text-foreground tracking-tight">One book. Five disciplines.</h2>
                    <p className="mt-3 text-foreground-secondary leading-relaxed">
                        Everything reads and writes the same double-entry ledger — so your net worth, your tax
                        estimate, and your invoice aging never disagree with each other.
                    </p>
                </div>
                <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
                    {PILLARS.map(pillar => (
                        <Link
                            key={pillar.slug}
                            href={`/features/${pillar.slug}`}
                            className="group bg-surface border border-border rounded-lg overflow-hidden hover:border-primary/60 transition-colors duration-150"
                        >
                            <div className="relative h-44">
                                <Image
                                    src={pillar.image}
                                    alt={pillar.alt}
                                    fill
                                    className="object-cover"
                                    sizes="(max-width: 768px) 100vw, (max-width: 1024px) 50vw, 33vw"
                                />
                                <div className="absolute inset-0 bg-background/35" aria-hidden />
                            </div>
                            <div className="p-6">
                                <div className="text-[11px] uppercase tracking-wider text-primary font-semibold mb-2">
                                    {pillar.label}
                                </div>
                                <h3 className="text-lg font-semibold text-foreground leading-snug">{pillar.title}</h3>
                                <p className="mt-2 text-sm text-foreground-muted leading-relaxed line-clamp-2">{pillar.tagline}</p>
                                <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary">
                                    Explore
                                    <svg className="w-4 h-4 transition-transform duration-150 group-hover:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12l-7.5 7.5M21 12H3" />
                                    </svg>
                                </span>
                            </div>
                        </Link>
                    ))}

                    {/* Precision panel fills the sixth grid cell */}
                    <div className="bg-surface border border-border rounded-lg p-6 flex flex-col">
                        <div className="text-[11px] uppercase tracking-wider text-foreground-muted font-semibold mb-2">
                            Precision first
                        </div>
                        <h3 className="text-lg font-semibold text-foreground leading-snug">
                            Every cent is a fraction, not a float.
                        </h3>
                        <div className="mt-4 flex-1 border border-border rounded-md overflow-hidden">
                            <table className="w-full text-xs font-mono" style={TNUM}>
                                <tbody>
                                    {DEMO_ROWS.map(row => (
                                        <tr key={row.desc} className="border-b border-border last:border-0">
                                            <td className="px-3 py-2 text-foreground-muted whitespace-nowrap">{row.date}</td>
                                            <td className="px-3 py-2 text-foreground-secondary max-w-0 w-full truncate">{row.desc}</td>
                                            <td className={`px-3 py-2 text-right whitespace-nowrap ${row.positive ? 'text-positive' : 'text-foreground-secondary'}`}>
                                                {row.amount}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <p className="mt-3 text-xs text-foreground-muted leading-relaxed">
                            Amounts are stored as exact numerator/denominator pairs — GnuCash&rsquo;s own format —
                            so balances never drift by a cent.
                        </p>
                    </div>
                </div>
            </section>

            {/* Ownership strip */}
            <section className="border-y border-border bg-background-secondary">
                <div className="max-w-7xl mx-auto px-6 py-16 grid gap-10 md:grid-cols-3">
                    <div>
                        <h3 className="text-base font-semibold text-foreground mb-2">Yours, verifiably</h3>
                        <p className="text-sm text-foreground-secondary leading-relaxed">
                            One Docker image against your PostgreSQL. Receipts and backups go to your filesystem
                            or S3. AI extraction uses the provider you configure — including local Ollama. No
                            telemetry, no third-party aggregator.
                        </p>
                    </div>
                    <div>
                        <h3 className="text-base font-semibold text-foreground mb-2">Desktop round-trip</h3>
                        <p className="text-sm text-foreground-secondary leading-relaxed">
                            The database is the standard GnuCash schema. Open the same book in GnuCash desktop,
                            export nightly backups as desktop-readable XML, and walk away any time with
                            everything intact.
                        </p>
                    </div>
                    <div>
                        <h3 className="text-base font-semibold text-foreground mb-2">Built for households</h3>
                        <p className="text-sm text-foreground-secondary leading-relaxed">
                            Multiple books, OIDC single sign-on, and per-book readonly/edit/admin roles. Give
                            your partner edit access and your accountant a read-only view.
                        </p>
                    </div>
                </div>
            </section>

            {/* CTA */}
            <section className="max-w-7xl mx-auto px-6 py-20">
                <div className="bg-surface border border-border rounded-lg px-8 py-12 lg:px-14 lg:py-14 flex flex-col lg:flex-row lg:items-center gap-8">
                    <div className="flex-1">
                        <h2 className="text-2xl lg:text-3xl font-bold text-foreground tracking-tight">
                            Ready when your ledger is.
                        </h2>
                        <p className="mt-3 text-foreground-secondary leading-relaxed max-w-xl">
                            Import a GnuCash XML file or start from a standard chart of accounts. Bank sync,
                            price quotes, and the background worker take it from there.
                        </p>
                    </div>
                    <div className="flex gap-3 shrink-0">
                        <Link
                            href="/login"
                            className="px-6 py-3 text-sm font-semibold bg-primary hover:bg-primary-hover text-primary-foreground rounded-md transition-colors duration-150"
                        >
                            Sign in
                        </Link>
                        <Link
                            href="/features/automation"
                            className="px-6 py-3 text-sm font-semibold border border-border hover:border-border-hover text-foreground rounded-md transition-colors duration-150"
                        >
                            See the automation
                        </Link>
                    </div>
                </div>
            </section>
        </>
    );
}
