import type { Metadata } from 'next';
import { DocsFeatureIndex } from '@/components/docs/DocsFeatureIndex';
import { FEATURES } from '@/lib/feature-registry';
import { featuresByReferenceDomain } from '@/lib/docs-reference';
import { product } from '@/lib/product';

export const metadata: Metadata = {
  title: `Feature reference — ${product.brand} Docs`,
  description: `Purpose, prerequisites, permissions, operation, and verification guidance for every registered ${product.name} feature.`,
};

export default function FeatureReferenceIndexPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <header className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Feature reference</p>
        <h1 className="mt-4 text-4xl font-bold tracking-tight text-foreground lg:text-5xl">
          Every capability, with an operating contract.
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-foreground-secondary">
          All {FEATURES.length} registered features document what they are for, what they require,
          what they read or change, and how to verify the result.
        </p>
      </header>
      <DocsFeatureIndex groups={featuresByReferenceDomain()} />
    </div>
  );
}
