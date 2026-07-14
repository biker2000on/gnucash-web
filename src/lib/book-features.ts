/**
 * Book feature modules — coarse-grained business capabilities that can be
 * toggled per book by admins. Each module defaults on or off from the book's
 * entity type (a 501(c)(3) club wants membership and bills, not invoicing;
 * a sole prop wants invoicing, not membership). Admin overrides live in
 * gnucash_web_book_features (see src/lib/services/book-features.service.ts);
 * absence of a row means "use the entity-type default".
 *
 * Client-safe: no server imports.
 */

import type { EntityType } from '@/lib/services/entity.service';

export type BookFeatureKey =
    | 'customers'
    | 'invoicing'
    | 'bills'
    | 'employees'
    | 'inventory'
    | 'sales_tax'
    | 'membership'
    | 'owner_planning'
    | 'packages'
    | 'funds'
    | 'documents';

export interface BookFeatureModule {
    key: BookFeatureKey;
    label: string;
    description: string;
}

export const BOOK_FEATURE_MODULES: BookFeatureModule[] = [
    { key: 'customers', label: 'Customers & Jobs', description: 'Customer records, jobs, and per-customer sales reporting.' },
    { key: 'invoicing', label: 'Invoicing', description: 'Invoices, recurring invoices, and accounts receivable.' },
    { key: 'bills', label: 'Vendors & Bills', description: 'Vendor records, bills, and accounts payable.' },
    { key: 'employees', label: 'Employees & Vouchers', description: 'Employee records and expense-voucher reimbursement.' },
    { key: 'inventory', label: 'Inventory', description: 'SKUs, locations, valuation, and COGS postings.' },
    { key: 'sales_tax', label: 'Sales Tax', description: 'Tax tables and the collected-tax filing report.' },
    { key: 'membership', label: 'Membership', description: 'Members, dues with renewal tracking, meetings, and attendance.' },
    { key: 'owner_planning', label: 'Owner Tax Planning', description: 'S-corp election analyzer and self-employed retirement planning.' },
    { key: 'packages', label: 'Prepaid Packages', description: 'Sell session packs as deferred revenue and draw them down per visit.' },
    { key: 'funds', label: 'Restricted Funds', description: 'Fund accounting: tag accounts by fund and report restricted vs unrestricted.' },
    { key: 'documents', label: 'Entity Documents', description: 'Formation docs, EIN letter, elections, insurance certs with expiry reminders.' },
];

export const BOOK_FEATURE_KEYS: BookFeatureKey[] = BOOK_FEATURE_MODULES.map(m => m.key);

/** Per-entity-type defaults. Household books hide the Business group entirely. */
export const BOOK_FEATURE_DEFAULTS: Record<EntityType, Record<BookFeatureKey, boolean>> = {
    household: {
        customers: false, invoicing: false, bills: false, employees: false,
        inventory: false, sales_tax: false, membership: false, owner_planning: false,
        packages: false, funds: false, documents: false,
    },
    sole_prop: {
        customers: true, invoicing: true, bills: true, employees: false,
        inventory: false, sales_tax: true, membership: false, owner_planning: true,
        packages: true, funds: false, documents: true,
    },
    llc_single: {
        customers: true, invoicing: true, bills: true, employees: false,
        inventory: false, sales_tax: true, membership: false, owner_planning: true,
        packages: true, funds: false, documents: true,
    },
    llc_partnership: {
        customers: true, invoicing: true, bills: true, employees: true,
        inventory: false, sales_tax: true, membership: false, owner_planning: true,
        packages: true, funds: false, documents: true,
    },
    s_corp: {
        customers: true, invoicing: true, bills: true, employees: true,
        inventory: false, sales_tax: true, membership: false, owner_planning: true,
        packages: true, funds: false, documents: true,
    },
    c_corp: {
        customers: true, invoicing: true, bills: true, employees: true,
        inventory: false, sales_tax: true, membership: false, owner_planning: false,
        packages: false, funds: false, documents: true,
    },
    nonprofit_501c3: {
        customers: false, invoicing: false, bills: true, employees: false,
        inventory: false, sales_tax: false, membership: true, owner_planning: false,
        packages: false, funds: true, documents: true,
    },
};

export type ResolvedBookFeatures = Record<BookFeatureKey, boolean>;

/** Apply admin overrides on top of the entity-type defaults. */
export function resolveBookFeatures(
    entityType: EntityType,
    overrides: Partial<Record<BookFeatureKey, boolean>>,
): ResolvedBookFeatures {
    const defaults = BOOK_FEATURE_DEFAULTS[entityType] ?? BOOK_FEATURE_DEFAULTS.household;
    const resolved = { ...defaults };
    for (const key of BOOK_FEATURE_KEYS) {
        if (overrides[key] !== undefined) resolved[key] = overrides[key]!;
    }
    return resolved;
}

/**
 * Which feature module gates each registry feature id. Ids not listed are
 * always visible on business books (dashboard, business settings, Schedule
 * C/E). Derived items: Payments and AR/AP Aging show when any of their
 * source modules are on.
 */
export const FEATURE_ID_TO_MODULE: Record<string, BookFeatureKey | BookFeatureKey[]> = {
    'biz-customers': 'customers',
    'biz-jobs': 'customers',
    'biz-customer-summary': 'customers',
    'rpt-sales-by-customer': 'customers',
    'biz-invoices': 'invoicing',
    'biz-recurring': 'invoicing',
    'biz-vendors': 'bills',
    'biz-bills': 'bills',
    'rpt-expenses-by-vendor': 'bills',
    'biz-employees': 'employees',
    'biz-vouchers': 'employees',
    'biz-inventory': 'inventory',
    'biz-sales-tax': 'sales_tax',
    'biz-membership': 'membership',
    'biz-meetings': 'membership',
    'biz-scorp-analyzer': 'owner_planning',
    'biz-retirement-planner': 'owner_planning',
    'biz-1099': 'bills',
    'biz-packages': 'packages',
    'biz-funds': 'funds',
    'biz-documents': 'documents',
    // Cross-module documents: visible when any source module is enabled.
    'biz-payments': ['invoicing', 'bills', 'employees'],
    'biz-aging': ['invoicing', 'bills'],
};

/** True when the registry feature id is enabled under the resolved modules. */
export function isFeatureIdEnabled(id: string, features: ResolvedBookFeatures): boolean {
    const gate = FEATURE_ID_TO_MODULE[id];
    if (gate === undefined) return true;
    if (Array.isArray(gate)) return gate.some(m => features[m]);
    return features[gate];
}
