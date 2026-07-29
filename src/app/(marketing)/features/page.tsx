import type { Metadata } from 'next';
import { PublicFeatureCatalog } from '@/components/marketing/PublicFeatureCatalog';
import { FEATURES } from '@/lib/feature-registry';
import { product } from '@/lib/product';

export const metadata: Metadata = {
  title: `All Features — ${product.brand}`,
  description: `Every registered ${product.name} page, report, tool, and workflow in one searchable catalog.`,
};

export default function AllFeaturesPage() {
  return (
    <section className="mx-auto max-w-7xl px-6 py-16 lg:py-20">
      <header className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Complete catalog</p>
        <h1 className="mt-4 text-4xl font-bold tracking-tight text-foreground lg:text-5xl">
          One ledger. An unusually complete financial operating system.
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-foreground-secondary">
          Browse every registered capability—from daily bookkeeping and tax-lot accounting to household
          planning, family-office consolidation, business operations, and administration.
        </p>
      </header>
      <PublicFeatureCatalog features={FEATURES} />
    </section>
  );
}
