import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FEATURES } from '../src/lib/feature-registry';
import {
  ADMIN_PAGES,
  CONCEPT_PAGES,
  allDocsSearchEntries,
  featureDocHref,
  featureReferencePage,
} from '../src/lib/docs-reference';

function fail(message: string): never {
  throw new Error(`Documentation coverage failed: ${message}`);
}

const featureIds = FEATURES.map((feature) => feature.id);
if (new Set(featureIds).size !== featureIds.length) {
  fail('feature registry contains duplicate IDs');
}

const searchEntries = allDocsSearchEntries();
const searchHrefs = new Set(searchEntries.map((entry) => entry.href));
for (const feature of FEATURES) {
  if (!feature.title.trim() || !feature.description.trim() || !feature.href.startsWith('/')) {
    fail(`feature ${feature.id} is missing its title, description, or application path`);
  }
  if (!searchHrefs.has(featureDocHref(feature))) {
    fail(`feature ${feature.id} is missing from documentation search`);
  }

  const page = featureReferencePage(feature);
  const headings = new Set(page.sections.map((section) => section.heading));
  for (const required of ['What it is for', 'Before you begin', 'How to use it', 'What it reads and changes', 'Verify the result']) {
    if (!headings.has(required)) fail(`feature ${feature.id} is missing the “${required}” section`);
  }
}

const fixedPages = [...CONCEPT_PAGES, ...ADMIN_PAGES];
const fixedSlugs = fixedPages.map((page) => `${page.kind}:${page.slug}`);
if (new Set(fixedSlugs).size !== fixedSlugs.length) {
  fail('concept or administration pages contain duplicate slugs');
}
for (const page of fixedPages) {
  if (page.sections.length < 2 || !page.summary.trim()) {
    fail(`${page.kind} page ${page.slug} does not contain substantive content`);
  }
}

for (const routeFile of [
  'src/app/docs/features/[id]/page.tsx',
  'src/app/docs/concepts/[slug]/page.tsx',
  'src/app/docs/admin/[slug]/page.tsx',
]) {
  if (!existsSync(resolve(process.cwd(), routeFile))) {
    fail(`required route is missing: ${routeFile}`);
  }
}

console.log(
  `Documentation coverage OK: ${FEATURES.length} feature references, ${CONCEPT_PAGES.length} concepts, ${ADMIN_PAGES.length} administration guides, ${searchEntries.length} searchable pages.`,
);
