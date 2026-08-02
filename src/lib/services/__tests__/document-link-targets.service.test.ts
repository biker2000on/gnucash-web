import { beforeEach, describe, expect, it, vi } from 'vitest';

const { meetings, homeItems, vendorScope, profileMock, entityProfile } = vi.hoisted(() => ({
  meetings: { findFirst: vi.fn() },
  homeItems: { findFirst: vi.fn() },
  vendorScope: vi.fn(),
  profileMock: vi.fn(),
  entityProfile: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    gnucash_web_meetings: meetings,
    gnucash_web_home_items: homeItems,
  },
}));
vi.mock('@/lib/business/vendor-1099.service', () => ({ assertVendor1099BookScope: vendorScope }));
vi.mock('@/lib/resilience/service', () => ({ getResilienceProfile: profileMock }));
vi.mock('@/lib/services/entity.service', () => ({ getEntityProfile: entityProfile }));

import {
  DOCUMENT_LINK_TARGET_ROLES,
  DocumentLinkTargetValidationError,
  validateDocumentLinkTarget,
} from '../document-link-targets.service';

const BOOK = 'book-1';
const UUID = 'a8fa77dd-5c3a-4d44-954a-d65fc4c751bd';

beforeEach(() => {
  vi.clearAllMocks();
  entityProfile.mockResolvedValue({ entityType: 'household', taxState: 'NC', businessActivity: 'general' });
});

describe('document link target contract', () => {
  it('defines only the roles supported by the six feature packs', () => {
    expect(DOCUMENT_LINK_TARGET_ROLES.vendor_1099).toEqual(['w9', 'form_1099_nec', 'filing_proof', 'correspondence']);
    expect(DOCUMENT_LINK_TARGET_ROLES.home_item).toContain('photo');
    expect(DOCUMENT_LINK_TARGET_ROLES.home_item).toContain('claim_evidence');
  });

  it('rejects a role that does not belong to the target type before querying', async () => {
    await expect(validateDocumentLinkTarget(BOOK, {
      targetType: 'home_item', targetId: '7', role: 'minutes',
    })).rejects.toBeInstanceOf(DocumentLinkTargetValidationError);
    expect(homeItems.findFirst).not.toHaveBeenCalled();
  });

  it('delegates vendor-year ownership to the book-scoped 1099 guard', async () => {
    await validateDocumentLinkTarget(BOOK, {
      targetType: 'vendor_1099',
      targetId: `${'a'.repeat(32)}:2026`,
      role: 'w9',
    });
    expect(vendorScope).toHaveBeenCalledWith(BOOK, 'a'.repeat(32));
  });

  it('rejects malformed and cross-book meeting targets', async () => {
    await expect(validateDocumentLinkTarget(BOOK, {
      targetType: 'membership_meeting', targetId: 'nope', role: 'minutes',
    })).rejects.toThrow('Invalid meeting target');

    meetings.findFirst.mockResolvedValue(null);
    await expect(validateDocumentLinkTarget(BOOK, {
      targetType: 'membership_meeting', targetId: '9', role: 'minutes',
    })).rejects.toThrow('Meeting not found in this book');
    expect(meetings.findFirst).toHaveBeenCalledWith({
      where: { id: 9, book_guid: BOOK }, select: { id: true },
    });
  });

  it('validates rental and donation IDs against the current book profile', async () => {
    profileMock.mockImplementation(async (_book: string, section: string) => section === 'rentals'
      ? { properties: [{ units: [{ id: UUID }] }] }
      : { donations: [{ id: UUID }] });

    await expect(validateDocumentLinkTarget(BOOK, {
      targetType: 'rental_unit', targetId: UUID, role: 'lease',
    })).resolves.toBeUndefined();
    await expect(validateDocumentLinkTarget(BOOK, {
      targetType: 'giving_donation', targetId: UUID, role: 'acknowledgment',
    })).resolves.toBeUndefined();
    await expect(validateDocumentLinkTarget(BOOK, {
      targetType: 'giving_donation', targetId: 'b3fa77dd-5c3a-4d44-954a-d65fc4c751bd', role: 'acknowledgment',
    })).rejects.toThrow('Donation not found in this book');
  });

  it('accepts legacy non-UUID IDs when they are present in this book profile', async () => {
    profileMock.mockImplementation(async (_book: string, section: string) => section === 'rentals'
      ? { properties: [{ units: [{ id: 'unit-legacy-17' }] }] }
      : { donations: [{ id: 'donation-2026-church' }] });

    await expect(validateDocumentLinkTarget(BOOK, {
      targetType: 'rental_unit', targetId: 'unit-legacy-17', role: 'lease',
    })).resolves.toBeUndefined();
    await expect(validateDocumentLinkTarget(BOOK, {
      targetType: 'giving_donation', targetId: 'donation-2026-church', role: 'acknowledgment',
    })).resolves.toBeUndefined();
  });

  it('requires a user context before validating a compliance target', async () => {
    await expect(validateDocumentLinkTarget(BOOK, {
      targetType: 'compliance_item', targetId: 'fed-1040:2026', role: 'filed_return',
    })).rejects.toThrow('requires a user context');
  });

  it('rejects a home item that is not in the active book', async () => {
    homeItems.findFirst.mockResolvedValue(null);
    await expect(validateDocumentLinkTarget(BOOK, {
      targetType: 'home_item', targetId: '12', role: 'manual',
    })).rejects.toThrow('Home item not found in this book');
  });

  it('accepts the legacy photo role for a book-scoped home item', async () => {
    homeItems.findFirst.mockResolvedValue({ id: 12 });
    await expect(validateDocumentLinkTarget(BOOK, {
      targetType: 'home_item', targetId: '12', role: 'photo',
    })).resolves.toBeUndefined();
    expect(homeItems.findFirst).toHaveBeenCalledWith({
      where: { id: 12, book_guid: BOOK }, select: { id: true },
    });
  });
});
