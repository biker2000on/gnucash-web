import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { DocsArticle } from '@/components/docs/DocsArticle';
import { FEATURES, featureById } from '@/lib/feature-registry';
import { featureReferencePage } from '@/lib/docs-reference';
import { product } from '@/lib/product';

export function generateStaticParams() {
  return FEATURES.map((feature) => ({ id: feature.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const feature = featureById(id);
  if (!feature) return {};
  return {
    title: `${feature.title} — ${product.brand} Docs`,
    description: feature.description,
  };
}

export default async function FeatureReferencePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const feature = featureById(id);
  if (!feature) notFound();

  return (
    <>
      <div className="mx-auto mb-5 flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
            Feature ID
          </div>
          <code className="text-xs text-foreground-secondary">{feature.id}</code>
        </div>
        <Link
          href={feature.href}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors duration-150 hover:bg-primary-hover"
        >
          Open {feature.title}
        </Link>
      </div>
      <DocsArticle page={featureReferencePage(feature)} />
    </>
  );
}
