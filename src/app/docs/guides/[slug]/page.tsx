import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { DocsArticle } from '@/components/docs/DocsArticle';
import { GUIDE_PAGES, guideBySlug } from '@/lib/docs-content';
import { product } from '@/lib/product';

export function generateStaticParams() {
  return GUIDE_PAGES.map((guide) => ({ slug: guide.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const guide = guideBySlug(slug);
  if (!guide) return {};
  return {
    title: `${guide.title} — ${product.brand} Docs`,
    description: guide.summary,
  };
}

export default async function GuidePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const guide = guideBySlug(slug);
  if (!guide) notFound();
  return <DocsArticle page={guide} />;
}
