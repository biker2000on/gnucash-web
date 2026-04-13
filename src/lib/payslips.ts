import prisma from '@/lib/prisma';
import type { PayslipStatus, PayslipLineItem } from '@/lib/types';

export interface PayslipFilters {
  status?: PayslipStatus;
  employer?: string;
}

export interface PayslipCreateData {
  book_guid: string;
  pay_date: Date;
  employer_name: string;
  pay_period_start?: Date;
  pay_period_end?: Date;
  gross_pay?: number;
  net_pay?: number;
  currency?: string;
  source?: string;
  source_id?: string;
  storage_key?: string;
  thumbnail_key?: string;
  status?: PayslipStatus;
  created_by?: number;
}

export interface MappingData {
  book_guid: string;
  employer_name: string;
  normalized_label: string;
  line_item_category: string;
  account_guid: string;
}

/**
 * List payslips for a book, optionally filtered by status and/or employer,
 * ordered by pay_date descending.
 */
export async function listPayslips(bookGuid: string, filters?: PayslipFilters) {
  const where: Record<string, unknown> = { book_guid: bookGuid };

  if (filters?.status) {
    where.status = filters.status;
  }
  if (filters?.employer) {
    where.employer_name = filters.employer;
  }

  return prisma.gnucash_web_payslips.findMany({
    where,
    orderBy: { pay_date: 'desc' },
  });
}

/**
 * Get a single payslip by id scoped to a book_guid.
 */
export async function getPayslip(id: number, bookGuid: string) {
  return prisma.gnucash_web_payslips.findFirst({
    where: { id, book_guid: bookGuid },
  });
}

/**
 * Create a new payslip record, defaulting status to 'processing'.
 */
export async function createPayslip(data: PayslipCreateData) {
  return prisma.gnucash_web_payslips.create({
    data: { status: 'processing', ...data },
  });
}

/**
 * Update the status of a payslip, plus any optional extra fields.
 */
export async function updatePayslipStatus(
  id: number,
  status: PayslipStatus,
  extra?: Record<string, unknown>
) {
  return prisma.gnucash_web_payslips.update({
    where: { id },
    data: { status, ...extra },
  });
}

/**
 * Update the parsed line_items JSONB field, and optionally the raw AI response.
 */
export async function updatePayslipLineItems(
  id: number,
  lineItems: PayslipLineItem[],
  rawResponse?: unknown
) {
  const data: Record<string, unknown> = { line_items: lineItems };
  if (rawResponse !== undefined) {
    data.raw_response = rawResponse;
  }
  return prisma.gnucash_web_payslips.update({
    where: { id },
    data,
  });
}

/**
 * Get all mappings for a specific employer within a book.
 */
export async function getMappingsForEmployer(bookGuid: string, employerName: string) {
  return prisma.gnucash_web_payslip_mappings.findMany({
    where: { book_guid: bookGuid, employer_name: employerName },
  });
}

/**
 * Upsert a line-item → account mapping by the composite unique key
 * (book_guid, employer_name, normalized_label, line_item_category).
 */
export async function upsertMapping(data: MappingData) {
  const { book_guid, employer_name, normalized_label, line_item_category, account_guid } = data;
  return prisma.gnucash_web_payslip_mappings.upsert({
    where: {
      book_guid_employer_name_normalized_label_line_item_category: {
        book_guid,
        employer_name,
        normalized_label,
        line_item_category,
      },
    },
    create: data,
    update: { account_guid },
  });
}

/**
 * Delete a payslip by id, scoped to a book_guid.
 */
export async function deletePayslip(id: number, bookGuid: string) {
  return prisma.gnucash_web_payslips.delete({
    where: { id, book_guid: bookGuid },
  });
}

export interface TemplateLineItem {
  category: string;
  label: string;
  normalized_label: string;
}

/**
 * Get the saved template for an employer within a book.
 */
export async function getTemplate(bookGuid: string, employerName: string) {
  return prisma.gnucash_web_payslip_templates.findUnique({
    where: {
      book_guid_employer_name: { book_guid: bookGuid, employer_name: employerName },
    },
  });
}

/**
 * Upsert a template for an employer. Stores line item structure (labels + categories, no amounts).
 */
export async function upsertTemplate(
  bookGuid: string,
  employerName: string,
  lineItems: TemplateLineItem[]
) {
  return prisma.gnucash_web_payslip_templates.upsert({
    where: {
      book_guid_employer_name: { book_guid: bookGuid, employer_name: employerName },
    },
    create: {
      book_guid: bookGuid,
      employer_name: employerName,
      line_items: lineItems,
    },
    update: {
      line_items: lineItems,
      updated_at: new Date(),
    },
  });
}
