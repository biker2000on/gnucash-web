import { describe, expect, it } from 'vitest';
import {
  getEditDocumentTypeOptions,
  getEntityDocumentContext,
} from '@/lib/entity-document-context';

describe('getEntityDocumentContext', () => {
  const entityTitles = {
    household: 'Household Documents',
    sole_prop: 'Sole Proprietorship Documents',
    llc_single: 'Single-Member LLC Documents',
    llc_partnership: 'Partnership LLC Documents',
    s_corp: 'S-Corp Documents',
    c_corp: 'C-Corp Documents',
    nonprofit_501c3: 'Nonprofit Documents',
  } as const;

  for (const [entityType, title] of Object.entries(entityTitles)) {
    it(`returns an exhaustive context for ${entityType}`, () => {
      const context = getEntityDocumentContext({
        entityType,
        entityName: 'Example Entity',
        businessActivity: 'general',
      });

      expect(context.title).toBe(title);
      expect(context.subtitle).toContain('Example Entity');
      expect(context.uploadTitlePlaceholder).not.toBe('');
      expect(context.notesPlaceholder).not.toBe('');
      expect(context.starterExamples.length).toBeGreaterThanOrEqual(4);
      expect(context.typeOptions.at(-1)?.value).toBe('other');
      expect(new Set(context.typeOptions.map(({ value }) => value)).size).toBe(
        context.typeOptions.length
      );
    });
  }

  it('keeps household choices personal and excludes business-only records', () => {
    const context = getEntityDocumentContext({
      entityType: 'household',
      businessActivity: 'farm',
    });
    const values = context.typeOptions.map(({ value }) => value);

    expect(values).toEqual(
      expect.arrayContaining(['identity', 'tax', 'property', 'estate', 'insurance'])
    );
    for (const businessOnlyType of [
      'formation',
      'ein',
      'election',
      'governance',
      'determination',
      'farm_certificate_qf',
      'farm_certificate_cf',
    ]) {
      expect(values).not.toContain(businessOnlyType);
    }
    expect(context.subtitle).not.toContain('Farm activity');
  });

  it('emphasizes nonprofit formation, determination, governance, 990/tax, and insurance', () => {
    const context = getEntityDocumentContext({ entityType: 'nonprofit_501c3' });
    const copy = [context.subtitle, ...context.starterExamples].join(' ');

    expect(copy).toMatch(/articles/i);
    expect(copy).toMatch(/bylaws/i);
    expect(copy).toMatch(/IRS determination/i);
    expect(copy).toMatch(/governance/i);
    expect(copy).toMatch(/Form 990/i);
    expect(copy).toMatch(/insurance/i);
    expect(context.typeOptions.map(({ value }) => value)).toEqual(
      expect.arrayContaining(['formation', 'determination', 'governance', 'tax', 'insurance'])
    );
  });

  it('layers farm guidance and both North Carolina certificate types onto a business', () => {
    const context = getEntityDocumentContext({
      entityType: 'sole_prop',
      businessActivity: 'farm',
    });
    const values = context.typeOptions.map(({ value }) => value);
    const copy = [context.subtitle, context.uploadTitlePlaceholder, ...context.starterExamples].join(
      ' '
    );

    expect(values).toEqual(
      expect.arrayContaining(['farm_certificate_qf', 'farm_certificate_cf'])
    );
    expect(copy).toContain('Farm activity');
    expect(copy).toContain('E-595QF');
    expect(copy).toContain('E-595CF');
  });

  it.each([undefined, null, { entityType: 'future_entity', entityName: 'Unknown Co' }])(
    'uses neutral copy for an unavailable or unknown profile',
    (profile) => {
      const context = getEntityDocumentContext(profile);
      const values = context.typeOptions.map(({ value }) => value);

      expect(context.title).toBe('Documents');
      expect(context.subtitle).not.toMatch(/household|business|entity/i);
      for (const misleadingType of [
        'formation',
        'ein',
        'election',
        'farm_certificate_qf',
        'farm_certificate_cf',
      ]) {
        expect(values).not.toContain(misleadingType);
      }
    }
  );

  it('retains an out-of-context or legacy current type for editing only', () => {
    const household = getEntityDocumentContext({ entityType: 'household' });
    const editOptions = getEditDocumentTypeOptions(household, 'formation');

    expect(household.typeOptions.some(({ value }) => value === 'formation')).toBe(false);
    expect(editOptions).toContainEqual({
      value: 'formation',
      label: 'Formation documents (existing type)',
    });
  });
});
