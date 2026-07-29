import {
  DOMAIN_LABELS,
  FEATURES,
  type Feature,
  type FeatureDomain,
} from '@/lib/feature-registry';
import {
  docsSearchEntries,
  type DocPage,
  type DocSearchEntry,
} from '@/lib/docs-content';

export interface ReferenceDocPage extends DocPage {
  slug: string;
}

export const CONCEPT_PAGES: ReferenceDocPage[] = [
  {
    slug: 'double-entry-and-books',
    title: 'Double-entry accounting, accounts, and books',
    summary: 'Understand the model that keeps every balance, report, and workflow tied to one auditable ledger.',
    kind: 'concept',
    readTime: '8 min',
    sections: [
      {
        heading: 'The invariant',
        paragraphs: [
          'Every financial event is a transaction containing two or more splits whose values balance to zero. Money does not appear or disappear: it moves between asset, liability, equity, income, and expense accounts.',
          'A book is the security, ownership, and reporting boundary around one chart of accounts. Households, businesses, trusts, and nonprofits should usually have separate books, then use authorized links and Family Office for consolidated views.',
        ],
      },
      {
        heading: 'Account roles',
        bullets: [
          'Assets represent resources you control, including cash, receivables, investments, inventory, and property.',
          'Liabilities represent obligations such as cards, loans, payables, taxes due, and deferred revenue.',
          'Income and expense accounts explain the period activity that changes equity.',
          'Equity records contributed capital, retained results, opening balances, and year-end closing entries.',
        ],
      },
      {
        heading: 'Why the model matters',
        paragraphs: [
          'Budgets, tax estimates, invoices, investment lots, plans, and dashboards all read the same balanced record. When a number looks wrong, follow its evidence to the transaction and correct the source instead of patching each report.',
        ],
      },
    ],
  },
  {
    slug: 'quantity-value-and-cost-basis',
    title: 'Quantity, value, prices, and cost basis',
    summary: 'See why an investment split can carry units, book value, market value, and tax lots without those concepts being interchangeable.',
    kind: 'concept',
    readTime: '9 min',
    sections: [
      {
        heading: 'Four different questions',
        bullets: [
          'Quantity answers how many shares, units, or currency units the split moves.',
          'Value answers how much the split contributes in the transaction currency.',
          'Price translates quantity into value at a point in time.',
          'Cost basis assigns acquisition value to tax lots so realized and unrealized gains can be calculated.',
        ],
      },
      {
        heading: 'Transfers and lots',
        paragraphs: [
          'Moving a holding between accounts should preserve economic ownership and lot history. Use lot assignment and scrub tools when transfers or sales have incomplete links; inspect the preview and resulting capital-gain entries before accepting them.',
        ],
      },
      {
        heading: 'Verification',
        bullets: [
          'Reconcile share quantities to the custodian statement.',
          'Review quote source and timestamp before relying on market value.',
          'Reconcile realized sales to Form 1099-B and inspect holding period and wash-sale warnings.',
        ],
      },
    ],
  },
  {
    slug: 'reconciliation-close-and-trust',
    title: 'Reconciliation, close, and the trust model',
    summary: 'Learn how reviewed activity, statement reconciliation, verified-through dates, and close locks establish confidence.',
    kind: 'concept',
    readTime: '7 min',
    sections: [
      {
        heading: 'Layers of confidence',
        bullets: [
          'Captured means activity exists in the ledger.',
          'Reviewed means its payee, category, amount, and evidence have been checked.',
          'Reconciled means the ledger agrees to an external statement through a closing date.',
          'Closed means the period checklist is complete and edits before the lock date require an explicit exception.',
        ],
      },
      {
        heading: 'Verified through',
        paragraphs: [
          'The verified-through date is conservative: it reflects the weakest material account, not the newest transaction anywhere in the book. The Action Center uses this state to tell you whether the books are current and what prevents a clean close.',
        ],
      },
      {
        heading: 'A practical cadence',
        steps: [
          'Resolve failed imports and uncertain transactions.',
          'Attach or match source documents.',
          'Reconcile statement accounts.',
          'Review stale prices, tax deadlines, and business close items.',
          'Lock a finished business period when appropriate.',
        ],
      },
    ],
  },
  {
    slug: 'provenance-preview-and-undo',
    title: 'Provenance, preview, approval, and undo',
    summary: 'Understand the safety contract behind explanations, recommendations, and ledger-changing commands.',
    kind: 'concept',
    readTime: '8 min',
    sections: [
      {
        heading: 'Explain before acting',
        paragraphs: [
          'Material figures and ranked opportunities can carry a stable calculation trace: formula, inputs, assumptions, warnings, intermediate steps, freshness, and links to source evidence.',
          'A trace explains a result; it does not make the result correct by authority. Use its source links to verify unusual or consequential numbers.',
        ],
      },
      {
        heading: 'Safe changes',
        bullets: [
          'Domain commands validate permissions and book scope.',
          'Material mutations preview the balanced transaction or configuration diff.',
          'Approval records who accepted the change and when.',
          'Audit history preserves the before and after state, with undo where the domain supports a safe reversal.',
        ],
      },
      {
        heading: 'AI boundaries',
        paragraphs: [
          'AI may extract, normalize, summarize, or propose. Deterministic code owns financial calculations, ranking inputs, validation, and mutations. Never treat generated prose as source evidence.',
        ],
      },
    ],
  },
  {
    slug: 'books-roles-and-family-office',
    title: 'Books, roles, ownership, and Family Office',
    summary: 'Choose the right book boundaries and understand how permission-safe consolidation works across entities.',
    kind: 'concept',
    readTime: '9 min',
    sections: [
      {
        heading: 'Separate legal and accounting boundaries',
        paragraphs: [
          'Use separate books when ownership, tax filing, governance, or access differs. Link books to describe relationships; do not duplicate transactions merely to create a consolidated dashboard.',
        ],
      },
      {
        heading: 'Permissions',
        bullets: [
          'Readonly can inspect supported records and reports without posting changes.',
          'Edit can maintain ordinary transactions and workflows.',
          'Admin manages users, roles, sensitive settings, and other privileged operations.',
          'A book link never grants access. Family Office includes only books the current user is already authorized to view.',
        ],
      },
      {
        heading: 'Consolidation',
        paragraphs: [
          'Ownership look-through, transfer matches, and approved eliminations affect presentation rather than rewriting source books. Unsupported currency conversions and missing evidence remain explicit exclusions.',
        ],
      },
    ],
  },
];

export const ADMIN_PAGES: ReferenceDocPage[] = [
  {
    slug: 'install-upgrade-and-health',
    title: 'Install, upgrade, and verify system health',
    summary: 'Operate the web app, worker, database, Redis, and object storage as one recoverable system.',
    kind: 'admin',
    readTime: '10 min',
    sections: [
      {
        heading: 'Before an upgrade',
        bullets: [
          'Confirm the database backup is recent and restorable.',
          'Record the running application revision and review release notes.',
          'Confirm the worker queue is healthy and no long-running import or posting job is active.',
          'Retain the previous immutable image so rollback does not depend on rebuilding it.',
        ],
      },
      {
        heading: 'Upgrade sequence',
        steps: [
          'Pull the exact application image you intend to run.',
          'Recreate the application and worker from the same image revision.',
          'Allow startup initialization to apply additive extension schema and indexes.',
          'Verify container health, login, a protected route, worker health, and one representative book.',
        ],
      },
      {
        heading: 'Rollback',
        paragraphs: [
          'Roll back the app and worker together to the prior immutable image. If a release contains a documented irreversible data migration, restore through the documented migration or backup procedure rather than mixing old code with new schema assumptions.',
        ],
      },
    ],
  },
  {
    slug: 'backups-storage-and-recovery',
    title: 'Backups, document storage, and recovery',
    summary: 'Protect the PostgreSQL ledger, extension data, receipts, statements, and desktop-readable exports.',
    kind: 'admin',
    readTime: '11 min',
    sections: [
      {
        heading: 'What must be protected',
        bullets: [
          'PostgreSQL contains the GnuCash-compatible core ledger plus Folio extension tables.',
          'Filesystem or S3-compatible storage contains source documents and generated artifacts.',
          'Environment and secret configuration is required to reconnect services but should be backed up outside the data archive.',
          'Desktop-readable exports provide portability; they do not replace a complete database and document backup.',
        ],
      },
      {
        heading: 'Recovery drill',
        steps: [
          'Restore into an isolated environment.',
          'Start the database and object storage before the app and worker.',
          'Sign in, open representative books, and verify balances, users, receipts, and scheduled jobs.',
          'Compare a known report and evidence manifest to the source environment.',
          'Record recovery time and any manual steps, then fix the procedure.',
        ],
      },
    ],
  },
  {
    slug: 'authentication-security-and-roles',
    title: 'Authentication, security, and book roles',
    summary: 'Configure sign-in, MFA, API tokens, sharing, and least-privilege access.',
    kind: 'admin',
    readTime: '10 min',
    sections: [
      {
        heading: 'Identity controls',
        bullets: [
          'Use a strong NEXTAUTH_SECRET and protect it like a database credential.',
          'Enable TOTP for privileged users and store recovery codes outside the application.',
          'Configure OIDC only over trusted HTTPS origins and validate callback URLs.',
          'Review active users, invitations, API tokens, webhooks, and public share links regularly.',
        ],
      },
      {
        heading: 'Least privilege',
        paragraphs: [
          'Assign roles per book. Give readonly access for reporting, edit access for day-to-day bookkeeping, and admin only to users who manage permissions or sensitive configuration. Linked books do not bypass these roles.',
        ],
      },
      {
        heading: 'Incident response',
        steps: [
          'Revoke affected sessions, tokens, share links, and invitations.',
          'Rotate exposed secrets and connector credentials.',
          'Review change history and external provider logs.',
          'Restore or undo supported mutations only after preserving evidence.',
        ],
      },
    ],
  },
  {
    slug: 'connections-ai-and-workers',
    title: 'Connections, AI providers, and background workers',
    summary: 'Configure optional external services without making them the source of truth.',
    kind: 'admin',
    readTime: '9 min',
    sections: [
      {
        heading: 'Connections',
        paragraphs: [
          'SimpleFIN, market data, email ingest, Stripe, S3-compatible storage, and AI providers are optional adapters. Their output is imported into or linked from the ledger; provider availability never changes the ownership of your books.',
        ],
      },
      {
        heading: 'Worker responsibilities',
        bullets: [
          'Scheduled transactions, refreshes, backups, report delivery, compliance reminders, dunning, and document processing run outside the request path.',
          'Redis coordinates queues and schedules; the worker must run the same application revision as the web service.',
          'Failed jobs should surface in job progress, notifications, or the Action Center rather than disappearing into logs.',
        ],
      },
      {
        heading: 'AI safety',
        paragraphs: [
          'Choose a provider and model explicitly, test the connection, and understand what document content leaves your infrastructure. Review extracted transactions before posting and keep deterministic calculations outside the model.',
        ],
      },
    ],
  },
  {
    slug: 'api-automation-and-webhooks',
    title: 'API tokens, automation, webhooks, and schedules',
    summary: 'Integrate safely with scoped credentials, idempotent commands, observable jobs, and revocable endpoints.',
    kind: 'admin',
    readTime: '10 min',
    sections: [
      {
        heading: 'Start with the contract',
        paragraphs: [
          'Use the OpenAPI reference to inspect request and response shapes. API tokens begin with gcw_ and are validated by route-level role checks. Never place a privileged token in client-side code.',
        ],
      },
      {
        heading: 'Operational rules',
        bullets: [
          'Use the least-privileged token and restrict its distribution.',
          'Treat posting and command endpoints as retry-sensitive; use documented idempotency or inspect the result before repeating.',
          'Monitor queued job IDs through job progress rather than assuming an accepted request is finished.',
          'Sign and validate inbound webhooks where supported, and rotate endpoints after exposure.',
          'Test report schedules, calendar feeds, email ingest, and outbound webhooks after upgrades.',
        ],
      },
    ],
  },
];

const KIND_USE: Record<Feature['kind'], string> = {
  action: 'carry out a focused workflow that can change book state',
  page: 'review and manage this part of the active book',
  report: 'analyze ledger data without changing source transactions',
  tool: 'calculate, diagnose, or prepare a decision before taking action',
};

function prerequisitesFor(feature: Feature): string[] {
  const prerequisites = [
    'Sign in and select the book whose records you intend to inspect.',
    'Confirm the book data and date range are current enough for the decision you are making.',
  ];
  if (feature.businessOnly) {
    prerequisites.push('Use a business-enabled book and ensure the corresponding business feature module is enabled.');
  }
  if (feature.personalOnly) {
    prerequisites.push('Use a household book; this capability is hidden on business and nonprofit books.');
  }
  prerequisites.push(
    feature.kind === 'report'
      ? 'Readonly access is sufficient to view the report; saving or changing supporting data may require edit access.'
      : 'Readonly users can inspect supported data. Posting, approving, or changing records requires the role enforced by that operation.',
  );
  return prerequisites;
}

function usageStepsFor(feature: Feature): string[] {
  const steps = [
    `Open ${feature.title} from ${DOMAIN_LABELS[feature.domain]} or search for it with Ctrl+K.`,
    `Choose the relevant book, account, period, entity, or scenario controls shown on the page.`,
  ];
  if (feature.kind === 'report') {
    steps.push('Review totals first, then drill into account, transaction, lot, or document evidence before exporting or sharing.');
  } else if (feature.kind === 'tool') {
    steps.push('Review prefilled inputs and assumptions, change only what you can support, and compare the resulting alternatives.');
  } else {
    steps.push('Work through unresolved items and use source links to verify any amount that is unusual or material.');
  }
  steps.push('Use “Explain this number” wherever it is available to inspect formulas, assumptions, freshness, and source evidence.');
  if (feature.kind !== 'report') {
    steps.push('For a material change, review the preview or balanced transaction before approval; confirm the audit record afterward.');
  }
  return steps;
}

function readsAndChangesFor(feature: Feature): string[] {
  const items = [
    `Reads the active book within the ${DOMAIN_LABELS[feature.domain]} domain and the ${feature.task.toLowerCase()} workflow.`,
  ];
  if (feature.kind === 'report') {
    items.push('Report generation does not rewrite source ledger transactions. Explicit save, schedule, share, or export controls create only the requested artifact or configuration.');
  } else if (feature.kind === 'tool') {
    items.push('Calculations and previews do not change the ledger. Only an explicit adopt, post, execute, or save action writes supported records.');
  } else {
    items.push('The page may expose explicit create, edit, approve, post, match, or execute controls. Each operation enforces its own role and validation rules.');
  }
  if (feature.businessOnly) items.push('Business records and generated postings stay inside the active business book.');
  return items;
}

export function featureReferencePage(feature: Feature): DocPage {
  return {
    slug: feature.id,
    title: feature.title,
    summary: feature.description,
    kind: 'reference',
    readTime: '5 min',
    sections: [
      {
        heading: 'What it is for',
        paragraphs: [
          `${feature.title} helps you ${KIND_USE[feature.kind]} in the “${feature.task}” workflow.`,
          feature.description,
        ],
      },
      {
        heading: 'Before you begin',
        bullets: prerequisitesFor(feature),
      },
      {
        heading: 'How to use it',
        steps: usageStepsFor(feature),
      },
      {
        heading: 'What it reads and changes',
        bullets: readsAndChangesFor(feature),
      },
      {
        heading: 'Verify the result',
        bullets: [
          'Confirm the result belongs to the intended book, period, account, owner, customer, or entity.',
          'Follow drill-through links to source transactions, documents, prices, rates, rules, and assumptions.',
          'Resolve stale-data, missing-evidence, reconciliation, or currency warnings before relying on a consequential result.',
          'After a mutation, inspect Change History and the affected ledger or workflow state.',
        ],
      },
      {
        heading: 'Availability',
        bullets: [
          `Application path: ${feature.href}`,
          `Domain: ${DOMAIN_LABELS[feature.domain]}`,
          `Feature type: ${feature.kind}`,
          `Book scope: ${feature.businessOnly ? 'business books with this module enabled' : feature.personalOnly ? 'household books' : 'available where the active book and user role support it'}`,
        ],
      },
    ],
  };
}

export function featureDocHref(feature: Feature): string {
  return `/docs/features/${feature.id}`;
}

export function referencePageBySlug(
  kind: 'concept' | 'admin',
  slug: string,
): ReferenceDocPage | undefined {
  const pages = kind === 'concept' ? CONCEPT_PAGES : ADMIN_PAGES;
  return pages.find((page) => page.slug === slug);
}

export function allDocsSearchEntries(): DocSearchEntry[] {
  const fixedPages: DocSearchEntry[] = [...CONCEPT_PAGES, ...ADMIN_PAGES].map((page) => ({
    title: page.title,
    summary: page.summary,
    href: `/docs/${page.kind === 'concept' ? 'concepts' : 'admin'}/${page.slug}`,
    category: page.kind === 'concept' ? 'Concept' : 'Administration',
    keywords: page.sections.map((section) => section.heading).join(' '),
  }));
  const featurePages: DocSearchEntry[] = FEATURES.map((feature) => ({
    title: feature.title,
    summary: feature.description,
    href: featureDocHref(feature),
    category: 'Feature reference',
    keywords: `${DOMAIN_LABELS[feature.domain]} ${feature.task} ${feature.kind} ${feature.keywords ?? ''}`,
  }));
  return [...docsSearchEntries(), ...fixedPages, ...featurePages];
}

export function resolveFeatureForPath(pathname: string): Feature | undefined {
  const normalized = pathname.split('?')[0].replace(/\/+$/, '') || '/';
  return FEATURES
    .filter((feature) => {
      const featurePath = feature.href.split('?')[0].replace(/\/+$/, '') || '/';
      return normalized === featurePath || (featurePath !== '/' && normalized.startsWith(`${featurePath}/`));
    })
    .sort((left, right) => right.href.split('?')[0].length - left.href.split('?')[0].length)[0];
}

export function featuresByReferenceDomain(): Array<{ domain: FeatureDomain; features: Feature[] }> {
  return (Object.keys(DOMAIN_LABELS) as FeatureDomain[])
    .map((domain) => ({ domain, features: FEATURES.filter((feature) => feature.domain === domain) }))
    .filter((entry) => entry.features.length > 0);
}
