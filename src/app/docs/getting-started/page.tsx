import type { Metadata } from 'next';
import { DocsArticle } from '@/components/docs/DocsArticle';
import { GETTING_STARTED } from '@/lib/docs-content';
import { product } from '@/lib/product';

export const metadata: Metadata = {
  title: `Getting Started — ${product.brand} Docs`,
  description: GETTING_STARTED.summary,
};

export default function GettingStartedPage() {
  return <DocsArticle page={GETTING_STARTED} />;
}
