/**
 * Account Template Types and Loader
 *
 * Provides type definitions for GnuCash account templates and functions
 * to load, query, and flatten template hierarchies for database insertion.
 */

import enUS from '@/data/account-templates/en_US.json';
import enGB from '@/data/account-templates/en_GB.json';

export type GnuCashAccountType =
  | 'ASSET' | 'BANK' | 'CASH' | 'CREDIT'
  | 'LIABILITY' | 'INCOME' | 'EXPENSE'
  | 'EQUITY' | 'RECEIVABLE' | 'PAYABLE'
  | 'STOCK' | 'MUTUAL' | 'TRADING' | 'ROOT';

export interface AccountTemplate {
  name: string;
  type: GnuCashAccountType;
  description?: string;
  placeholder?: boolean;
  children?: AccountTemplate[];
}

export interface TemplateFile {
  locale: string;
  id: string;
  name: string;
  description: string;
  currency: string;
  accounts: AccountTemplate[];
}

export interface TemplateLocale {
  code: string;
  name: string;
  templates: TemplateFile[];
}

export interface FlattenedAccount {
  name: string;
  type: GnuCashAccountType;
  description: string;
  placeholder: boolean;
  path: string;
  parentPath: string;
}

const locales: TemplateLocale[] = [
  {
    code: 'en_US',
    name: 'English (US)',
    templates: (enUS as { templates: TemplateFile[] }).templates,
  },
  {
    code: 'en_GB',
    name: 'English (UK)',
    templates: (enGB as { templates: TemplateFile[] }).templates,
  },
];

/**
 * Returns all bundled template locales with their templates.
 */
export function getAvailableTemplates(): TemplateLocale[] {
  return locales;
}

/**
 * Returns a specific template by locale code and template ID.
 */
export function getTemplate(localeCode: string, templateId: string): TemplateFile | null {
  const locale = locales.find(l => l.code === localeCode);
  if (!locale) return null;
  return locale.templates.find(t => t.id === templateId) ?? null;
}

/**
 * Flattens a template account tree into a flat list with full paths.
 * Accounts are returned in parent-first order so parents can be created
 * before their children during database insertion.
 */
export function flattenTemplate(
  accounts: AccountTemplate[],
  parentPath: string = ''
): FlattenedAccount[] {
  const result: FlattenedAccount[] = [];

  for (const account of accounts) {
    const path = parentPath ? `${parentPath}:${account.name}` : account.name;

    result.push({
      name: account.name,
      type: account.type,
      description: account.description ?? '',
      placeholder: account.placeholder ?? false,
      path,
      parentPath,
    });

    if (account.children && account.children.length > 0) {
      result.push(...flattenTemplate(account.children, path));
    }
  }

  return result;
}
