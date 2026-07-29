import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { DocsArticle } from '@/components/docs/DocsArticle';
import { CONCEPT_PAGES, referencePageBySlug } from '@/lib/docs-reference';

export function generateStaticParams() {
  return CONCEPT_PAGES.map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = referencePageBySlug('concept', slug);
  return page ? { title: `${page.title} — GnuCash Web Docs`, description: page.summary } : {};
}

export default async function ConceptPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const page = referencePageBySlug('concept', slug);
  if (!page) notFound();
  return <DocsArticle page={page} />;
}
