/**
 * Target validation for canonical document links.
 *
 * The document platform proves the linked document belongs to the active
 * book. This module proves the *target* does too, including targets retained
 * inside book-scoped resilience JSON.
 */

import prisma from '@/lib/prisma';
import { assertVendor1099BookScope } from '@/lib/business/vendor-1099.service';
import { complianceItemsForYear } from '@/lib/compliance';
import { getEntityProfile } from '@/lib/services/entity.service';
import { getResilienceProfile } from '@/lib/resilience/service';
import type { GivingProfile, RentalsProfile } from '@/lib/resilience/types';
import {
  ensureCanonicalDocumentPlatform,
  listDocumentLinks,
  unlinkDocument,
  type DocumentTargetType,
} from '@/lib/documents';

export const DOCUMENT_LINK_TARGET_ROLES = {
  vendor_1099: ['w9', 'form_1099_nec', 'filing_proof', 'correspondence'],
  rental_unit: ['lease', 'lease_addendum', 'move_in_inspection', 'tenant_notice', 'rent_statement'],
  membership_meeting: ['agenda', 'minutes', 'resolution', 'packet', 'recording_transcript'],
  giving_donation: ['acknowledgment', 'appraisal', 'form_8283', 'noncash_receipt', 'qcd_confirmation'],
  compliance_item: ['filed_return', 'payment_confirmation', 'government_notice', 'certificate', 'supporting_workpaper'],
  home_item: ['purchase_receipt', 'photo', 'warranty', 'manual', 'appraisal', 'serial_photo', 'claim_evidence'],
} as const;

export type DocumentLinkTargetType = keyof typeof DOCUMENT_LINK_TARGET_ROLES;
export type DocumentLinkTargetRole<T extends DocumentLinkTargetType = DocumentLinkTargetType> =
  (typeof DOCUMENT_LINK_TARGET_ROLES)[T][number];

export interface DocumentLinkTargetInput {
  targetType: DocumentLinkTargetType;
  targetId: string;
  /** Omit for a read-only target ownership check. */
  role?: string;
  /** Needed only when resolving a compliance ruleset with no stored profile. */
  userId?: number;
}

export class DocumentLinkTargetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentLinkTargetValidationError';
  }
}

export function isDocumentLinkTargetType(value: unknown): value is DocumentLinkTargetType {
  return typeof value === 'string' && value in DOCUMENT_LINK_TARGET_ROLES;
}

export function isDocumentLinkTargetRole(
  targetType: DocumentLinkTargetType,
  value: unknown,
): value is DocumentLinkTargetRole {
  return typeof value === 'string' && (DOCUMENT_LINK_TARGET_ROLES[targetType] as readonly string[]).includes(value);
}

function requirePositiveId(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new DocumentLinkTargetValidationError(`Invalid ${label}`);
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new DocumentLinkTargetValidationError(`Invalid ${label}`);
  return id;
}

function splitVendorYear(value: string): { vendorGuid: string; taxYear: number } {
  const match = /^([0-9a-f]{32}):(\d{4})$/i.exec(value);
  if (!match) throw new DocumentLinkTargetValidationError('Invalid vendor 1099 target');
  const taxYear = Number(match[2]);
  if (taxYear < 1990 || taxYear > 2100) throw new DocumentLinkTargetValidationError('Invalid vendor 1099 target');
  return { vendorGuid: match[1], taxYear };
}

function splitComplianceItem(value: string): { itemKey: string; period: string; year: number } {
  const idx = value.lastIndexOf(':');
  if (idx <= 0 || idx === value.length - 1) {
    throw new DocumentLinkTargetValidationError('Invalid compliance target');
  }
  const itemKey = value.slice(0, idx);
  const period = value.slice(idx + 1);
  const yearMatch = /^(\d{4})(?:-Q[1-4])?$/.exec(period);
  if (!yearMatch) throw new DocumentLinkTargetValidationError('Invalid compliance target');
  return { itemKey, period, year: Number(yearMatch[1]) };
}

/** Validate a target and role before the canonical platform writes a link. */
export async function validateDocumentLinkTarget(
  bookGuid: string,
  input: DocumentLinkTargetInput,
): Promise<void> {
  if (!isDocumentLinkTargetType(input.targetType)) {
    throw new DocumentLinkTargetValidationError('Invalid document link target type');
  }
  if (input.role !== undefined && !isDocumentLinkTargetRole(input.targetType, input.role)) {
    throw new DocumentLinkTargetValidationError('Invalid document link role for target type');
  }
  if (!input.targetId || input.targetId.length > 255) {
    throw new DocumentLinkTargetValidationError('Invalid document link target');
  }

  switch (input.targetType) {
    case 'vendor_1099': {
      const { vendorGuid } = splitVendorYear(input.targetId);
      await assertVendor1099BookScope(bookGuid, vendorGuid);
      return;
    }
    case 'rental_unit': {
      const rentals = await getResilienceProfile(bookGuid, 'rentals') as RentalsProfile;
      if (!rentals.properties.some(property => property.units.some(unit => unit.id === input.targetId))) {
        throw new DocumentLinkTargetValidationError('Rental unit not found in this book');
      }
      return;
    }
    case 'membership_meeting': {
      const id = requirePositiveId(input.targetId, 'meeting target');
      const meeting = await prisma.gnucash_web_meetings.findFirst({
        where: { id, book_guid: bookGuid },
        select: { id: true },
      });
      if (!meeting) throw new DocumentLinkTargetValidationError('Meeting not found in this book');
      return;
    }
    case 'giving_donation': {
      const giving = await getResilienceProfile(bookGuid, 'giving') as GivingProfile;
      if (!giving.donations.some(donation => donation.id === input.targetId)) {
        throw new DocumentLinkTargetValidationError('Donation not found in this book');
      }
      return;
    }
    case 'compliance_item': {
      if (input.userId === undefined) {
        throw new DocumentLinkTargetValidationError('Compliance target validation requires a user context');
      }
      const { itemKey, period, year } = splitComplianceItem(input.targetId);
      const entity = await getEntityProfile(bookGuid, input.userId);
      const found = complianceItemsForYear(
        entity.entityType,
        entity.taxState,
        year,
        entity.businessActivity,
      ).some(item => item.key === itemKey && item.period === period);
      if (!found) throw new DocumentLinkTargetValidationError('Compliance item not found for this book');
      return;
    }
    case 'home_item': {
      const id = requirePositiveId(input.targetId, 'home item target');
      const item = await prisma.gnucash_web_home_items.findFirst({
        where: { id, book_guid: bookGuid },
        select: { id: true },
      });
      if (!item) throw new DocumentLinkTargetValidationError('Home item not found in this book');
      return;
    }
  }
}

/**
 * Remove every canonical edge for a target before its source record is
 * deleted. Documents are deliberately retained: they may be linked elsewhere
 * and remain part of the book's vault/search history.
 */
export async function unlinkDocumentLinksForTarget(
  bookGuid: string,
  targetType: DocumentLinkTargetType,
  targetId: string,
): Promise<number> {
  await ensureCanonicalDocumentPlatform();
  const links = await listDocumentLinks({
    bookGuid,
    targetType: targetType as DocumentTargetType,
    targetId,
  });
  await Promise.all(links.map(link => unlinkDocument({
    bookGuid,
    documentId: link.documentId,
    targetType: targetType as DocumentTargetType,
    targetId,
    role: link.role as Parameters<typeof unlinkDocument>[0]['role'],
  })));
  return links.length;
}
