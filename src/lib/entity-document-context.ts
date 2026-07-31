/**
 * Client-safe document-vault context.
 *
 * Keep this module free of service, Prisma, and other server-only imports so
 * client pages can tailor copy and document types from the canonical entity
 * profile returned by /api/entity.
 */

export const DOCUMENT_TYPE_DEFINITIONS = [
  { value: 'formation', label: 'Formation documents' },
  { value: 'ein', label: 'EIN letters' },
  { value: 'election', label: 'Tax elections' },
  { value: 'insurance', label: 'Insurance' },
  { value: 'license', label: 'Licenses and permits' },
  { value: 'agreement', label: 'Agreements' },
  { value: 'farm_certificate_qf', label: 'E-595QF certificates' },
  { value: 'farm_certificate_cf', label: 'E-595CF certificates' },
  { value: 'identity', label: 'Identity records' },
  { value: 'tax', label: 'Tax filings and notices' },
  { value: 'property', label: 'Property records' },
  { value: 'estate', label: 'Estate planning' },
  { value: 'governance', label: 'Governance' },
  { value: 'determination', label: 'IRS determination' },
  { value: 'other', label: 'Other' },
] as const;

export const DOCUMENT_TYPE_VALUES = DOCUMENT_TYPE_DEFINITIONS.map(
  ({ value }) => value
) as Array<(typeof DOCUMENT_TYPE_DEFINITIONS)[number]['value']>;

export type DocumentTypeValue = (typeof DOCUMENT_TYPE_DEFINITIONS)[number]['value'];

export interface DocumentTypeOption {
  value: string;
  label: string;
}

export interface EntityDocumentProfile {
  entityType?: string | null;
  entityName?: string | null;
  businessActivity?: string | null;
}

export interface EntityDocumentContext {
  title: string;
  subtitle: string;
  uploadTitlePlaceholder: string;
  notesPlaceholder: string;
  starterIntro: string;
  starterExamples: string[];
  typeOptions: DocumentTypeOption[];
}

interface BaseContext extends Omit<EntityDocumentContext, 'typeOptions'> {
  typeValues: DocumentTypeValue[];
}

const LABELS = new Map<string, string>(
  DOCUMENT_TYPE_DEFINITIONS.map(({ value, label }) => [value, label])
);

const NEUTRAL_CONTEXT: BaseContext = {
  title: 'Documents',
  subtitle: 'Store important records, reference files, and renewals with expiry tracking.',
  uploadTitlePlaceholder: 'e.g. Annual insurance policy',
  notesPlaceholder: 'Reference number, date, contact, or follow-up details…',
  starterIntro: 'No documents yet. Useful records to keep here include:',
  starterExamples: ['identity records', 'tax notices', 'property records', 'insurance policies'],
  typeValues: ['identity', 'tax', 'property', 'estate', 'insurance', 'agreement', 'other'],
};

const ENTITY_CONTEXTS: Record<string, BaseContext> = {
  household: {
    title: 'Household Documents',
    subtitle:
      'Keep personal and household records together, including identity, tax, property, estate, and insurance documents.',
    uploadTitlePlaceholder: 'e.g. Home insurance declaration',
    notesPlaceholder: 'Policy number, tax year, property, contact, or follow-up details…',
    starterIntro: 'No household documents yet. A practical starter set includes:',
    starterExamples: [
      'identity records',
      'recent tax filings and notices',
      'property records',
      'estate planning documents',
      'insurance policies',
    ],
    typeValues: ['identity', 'tax', 'property', 'estate', 'insurance', 'agreement', 'other'],
  },
  sole_prop: {
    title: 'Sole Proprietorship Documents',
    subtitle:
      'Keep the records that support this sole proprietorship, including tax registrations, permits, contracts, and insurance.',
    uploadTitlePlaceholder: 'e.g. EIN assignment letter',
    notesPlaceholder: 'Tax year, permit number, policy number, renewal contact, or filing details…',
    starterIntro: 'No sole proprietorship documents yet. A useful starter set includes:',
    starterExamples: [
      'EIN assignment letter',
      'business licenses and permits',
      'client or vendor agreements',
      'insurance certificates',
      'tax filings and notices',
    ],
    typeValues: ['ein', 'tax', 'license', 'agreement', 'insurance', 'property', 'other'],
  },
  llc_single: {
    title: 'Single-Member LLC Documents',
    subtitle:
      'Keep this LLC’s formation, operating, tax, licensing, contract, and insurance records in one place.',
    uploadTitlePlaceholder: 'e.g. Articles of organization',
    notesPlaceholder: 'Filing date, document number, registered agent, renewal, or policy details…',
    starterIntro: 'No single-member LLC documents yet. A useful starter set includes:',
    starterExamples: [
      'articles of organization',
      'operating agreement',
      'EIN assignment letter',
      'licenses and permits',
      'insurance certificates',
    ],
    typeValues: [
      'formation',
      'ein',
      'agreement',
      'governance',
      'tax',
      'license',
      'insurance',
      'property',
      'other',
    ],
  },
  llc_partnership: {
    title: 'Partnership LLC Documents',
    subtitle:
      'Keep this partnership LLC’s formation, operating, ownership, tax, licensing, and insurance records together.',
    uploadTitlePlaceholder: 'e.g. Multi-member operating agreement',
    notesPlaceholder: 'Filing date, ownership terms, document number, renewal, or policy details…',
    starterIntro: 'No partnership LLC documents yet. A useful starter set includes:',
    starterExamples: [
      'articles of organization',
      'multi-member operating agreement',
      'EIN assignment letter',
      'ownership and governance records',
      'insurance certificates',
    ],
    typeValues: [
      'formation',
      'ein',
      'agreement',
      'governance',
      'tax',
      'license',
      'insurance',
      'property',
      'other',
    ],
  },
  s_corp: {
    title: 'S-Corp Documents',
    subtitle:
      'Keep this S corporation’s formation, election, governance, tax, licensing, and insurance records together.',
    uploadTitlePlaceholder: 'e.g. Form 2553 acceptance letter',
    notesPlaceholder: 'Filing date, tax year, resolution, policy number, or renewal details…',
    starterIntro: 'No S-Corp documents yet. A useful starter set includes:',
    starterExamples: [
      'articles of incorporation or organization',
      'EIN assignment letter',
      'Form 2553 and IRS acceptance',
      'bylaws, resolutions, and meeting minutes',
      'insurance certificates',
    ],
    typeValues: [
      'formation',
      'ein',
      'election',
      'governance',
      'tax',
      'license',
      'agreement',
      'insurance',
      'property',
      'other',
    ],
  },
  c_corp: {
    title: 'C-Corp Documents',
    subtitle:
      'Keep this C corporation’s formation, governance, tax, election, licensing, contract, and insurance records together.',
    uploadTitlePlaceholder: 'e.g. Articles of incorporation',
    notesPlaceholder: 'Filing date, resolution, tax year, policy number, or renewal details…',
    starterIntro: 'No C-Corp documents yet. A useful starter set includes:',
    starterExamples: [
      'articles of incorporation',
      'bylaws and shareholder agreements',
      'EIN assignment letter',
      'board resolutions and meeting minutes',
      'tax filings and insurance certificates',
    ],
    typeValues: [
      'formation',
      'ein',
      'governance',
      'election',
      'tax',
      'license',
      'agreement',
      'insurance',
      'property',
      'other',
    ],
  },
  nonprofit_501c3: {
    title: 'Nonprofit Documents',
    subtitle:
      'Keep the nonprofit’s articles and bylaws, IRS determination, governance, Form 990 and tax records, and insurance together.',
    uploadTitlePlaceholder: 'e.g. IRS determination letter',
    notesPlaceholder: 'Tax year, board action, filing date, policy number, or renewal details…',
    starterIntro: 'No nonprofit documents yet. A strong governance and compliance starter set includes:',
    starterExamples: [
      'articles of incorporation and bylaws',
      'IRS determination letter',
      'board minutes and governance policies',
      'Form 990 and related tax filings',
      'insurance policies',
    ],
    typeValues: [
      'formation',
      'governance',
      'determination',
      'ein',
      'tax',
      'insurance',
      'license',
      'agreement',
      'property',
      'other',
    ],
  },
};

function toOptions(values: readonly DocumentTypeValue[]): DocumentTypeOption[] {
  return values.map((value) => ({ value, label: LABELS.get(value) ?? value }));
}

function namedSubtitle(subtitle: string, entityName: string | null | undefined): string {
  const name = entityName?.trim();
  return name ? `${name}: ${subtitle.charAt(0).toLowerCase()}${subtitle.slice(1)}` : subtitle;
}

/**
 * Resolve all document-page copy and upload categories from an entity profile.
 * Unknown/missing profiles deliberately use neutral copy instead of assuming
 * the book is either a household or a business.
 */
export function getEntityDocumentContext(
  profile: EntityDocumentProfile | null | undefined
): EntityDocumentContext {
  const base = profile?.entityType ? ENTITY_CONTEXTS[profile.entityType] : undefined;
  const resolved = base ?? NEUTRAL_CONTEXT;
  const isFarm = Boolean(
    base && profile?.entityType !== 'household' && profile?.businessActivity === 'farm'
  );
  const farmTypes: DocumentTypeValue[] = isFarm
    ? ['farm_certificate_qf', 'farm_certificate_cf']
    : [];

  return {
    title: resolved.title,
    subtitle:
      namedSubtitle(resolved.subtitle, base ? profile?.entityName : null) +
      (isFarm
        ? ' Farm activity: also keep E-595QF qualifying-farmer and E-595CF conditional-farmer certificates current.'
        : ''),
    uploadTitlePlaceholder: isFarm
      ? 'e.g. E-595QF qualifying-farmer certificate'
      : resolved.uploadTitlePlaceholder,
    notesPlaceholder: resolved.notesPlaceholder,
    starterIntro: resolved.starterIntro,
    starterExamples: isFarm
      ? [
          ...resolved.starterExamples,
          'E-595QF qualifying-farmer certificate',
          'E-595CF conditional-farmer certificate',
        ]
      : [...resolved.starterExamples],
    typeOptions: toOptions([
      ...resolved.typeValues.filter((value) => value !== 'other'),
      ...farmTypes,
      'other',
    ]),
  };
}

export function getDocumentTypeLabel(value: string): string {
  return LABELS.get(value) ?? value.replace(/_/g, ' ');
}

/** Upload choices stay contextual; edit choices additionally retain a legacy current type. */
export function getEditDocumentTypeOptions(
  context: EntityDocumentContext,
  currentType: string
): DocumentTypeOption[] {
  if (context.typeOptions.some(({ value }) => value === currentType)) {
    return context.typeOptions;
  }
  return [
    ...context.typeOptions,
    { value: currentType, label: `${getDocumentTypeLabel(currentType)} (existing type)` },
  ];
}
