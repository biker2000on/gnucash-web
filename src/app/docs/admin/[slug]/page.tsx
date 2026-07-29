import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { DocsArticle } from '@/components/docs/DocsArticle';
import { ADMIN_PAGES, referencePageBySlug } from '@/lib/docs-reference';
import { product } from '@/lib/product';

export function generateStaticParams() {
  return ADMIN_PAGES.map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = referencePageBySlug('admin', slug);
  return page ? { title: `${page.title} — ${product.brand} Docs`, description: page.summary } : {};
}

export default async function AdminPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const page = referencePageBySlug('admin', slug);
  if (!page) notFound();
  return <DocsArticle page={page} />;
}
