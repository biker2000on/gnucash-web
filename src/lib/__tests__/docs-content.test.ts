import { describe, expect, it } from 'vitest';
import {
  GETTING_STARTED,
  GUIDE_PAGES,
  docsSearchEntries,
  guideBySlug,
} from '@/lib/docs-content';

describe('public documentation content', () => {
  it('keeps guide slugs unique and resolvable', () => {
    const slugs = GUIDE_PAGES.map((guide) => guide.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(guideBySlug(slug)?.slug).toBe(slug);
    }
  });

  it('gives every tutorial and guide actionable sections', () => {
    for (const page of [GETTING_STARTED, ...GUIDE_PAGES]) {
      expect(page.title.length).toBeGreaterThan(10);
      expect(page.summary.length).toBeGreaterThan(20);
      expect(page.sections.length).toBeGreaterThanOrEqual(2);
      expect(page.sections.some((section) => section.steps?.length)).toBe(true);
    }
  });

  it('indexes every release-one document', () => {
    const hrefs = new Set(docsSearchEntries().map((entry) => entry.href));
    expect(hrefs.has('/docs/getting-started')).toBe(true);
    for (const guide of GUIDE_PAGES) {
      expect(hrefs.has(`/docs/guides/${guide.slug}`)).toBe(true);
    }
    expect(hrefs.has('/docs/api')).toBe(true);
  });
});
