import { describe, expect, it } from 'vitest';
import { searchCommands } from '@/lib/command-palette';
import { FEATURES } from '@/lib/feature-registry';
import {
  ADMIN_PAGES,
  CONCEPT_PAGES,
  allDocsSearchEntries,
  featureDocHref,
  featureReferencePage,
  resolveFeatureForPath,
} from '@/lib/docs-reference';

describe('complete documentation reference', () => {
  it('covers every registered feature in search and reference content', () => {
    const hrefs = new Set(allDocsSearchEntries().map((entry) => entry.href));

    for (const feature of FEATURES) {
      expect(hrefs.has(featureDocHref(feature))).toBe(true);
      const page = featureReferencePage(feature);
      expect(page.title).toBe(feature.title);
      expect(page.sections.map((section) => section.heading)).toEqual(
        expect.arrayContaining([
          'What it is for',
          'Before you begin',
          'How to use it',
          'What it reads and changes',
          'Verify the result',
        ]),
      );
    }
  });

  it('keeps concept and administration slugs unique', () => {
    const keys = [...CONCEPT_PAGES, ...ADMIN_PAGES].map((page) => `${page.kind}:${page.slug}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('resolves contextual help to the most specific feature route', () => {
    expect(resolveFeatureForPath('/investments/rebalancing')?.id).toBe('nav-inv-rebalancing');
    expect(resolveFeatureForPath('/accounts/example-guid')?.id).toBe('nav-accounts');
    expect(resolveFeatureForPath('/business/invoices/example-guid')?.id).toBe('biz-invoices');
    expect(resolveFeatureForPath('/not-a-feature')).toBeUndefined();
  });

  it('makes documentation discoverable in the command palette', () => {
    expect(searchCommands('documentation').some((command) => command.href === '/docs')).toBe(true);
    expect(searchCommands('backup').some((command) => command.href === '/docs/admin')).toBe(true);
    expect(searchCommands('openapi').some((command) => command.href === '/docs/api')).toBe(true);
  });
});
