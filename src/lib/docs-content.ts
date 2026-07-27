export type DocKind = 'tutorial' | 'guide' | 'concept' | 'admin' | 'reference';

export interface DocSection {
  heading: string;
  paragraphs?: string[];
  steps?: string[];
  bullets?: string[];
}

export interface DocPage {
  slug: string;
  title: string;
  summary: string;
  kind: DocKind;
  readTime: string;
  sections: DocSection[];
}

export interface DocSearchEntry {
  title: string;
  summary: string;
  href: string;
  category: string;
  keywords?: string;
}

export const GETTING_STARTED: DocPage = {
  slug: 'getting-started',
  title: 'Get from a book to a trustworthy weekly review',
  summary:
    'Import or create a book, verify the account tree, record activity, attach evidence, and complete your first review.',
  kind: 'tutorial',
  readTime: '12 min',
  sections: [
    {
      heading: 'What you will accomplish',
      paragraphs: [
        'By the end, you will have a working book, one verified transaction, supporting evidence, and a repeatable weekly review. You do not need to configure every module first.',
      ],
      bullets: [
        'A book with the right currency and account structure',
        'A transaction entered or imported into the ledger',
        'A receipt or statement attached as evidence',
        'A reviewed Action Center and reconciliation starting point',
      ],
    },
    {
      heading: '1. Open or create a book',
      steps: [
        'Sign in. If this is a new installation, follow onboarding to create a household or business book.',
        'To reuse existing history, import a GnuCash XML file. To start clean, choose a chart-of-accounts template that matches the entity.',
        'Open Accounts and confirm that Assets, Liabilities, Equity, Income, and Expenses appear in the expected hierarchy.',
      ],
    },
    {
      heading: '2. Set the book context',
      steps: [
        'Open Settings and confirm the entity type, base currency, date format, and balance-display preference.',
        'If other people need access, assign per-book roles under Settings → Users. Read-only users can inspect reports without changing the ledger.',
        'Configure receipt storage, backups, and an AI provider only if you plan to use those workflows.',
      ],
    },
    {
      heading: '3. Put activity in the ledger',
      steps: [
        'Use Quick Add for a simple purchase, or open General Ledger and choose New Transaction for a complete split transaction.',
        'Alternatively, connect SimpleFIN or import a CSV, OFX, QIF, or supported application export.',
        'Open the transaction and confirm that its splits balance. The account ledger should show the expected running balance.',
      ],
    },
    {
      heading: '4. Add evidence',
      steps: [
        'Open Receipts and upload a photo or PDF, or attach it directly from a transaction.',
        'Review the OCR result and suggested match before accepting it. The original document remains the evidence source.',
        'For a bank statement, open Statements, upload the file, choose its account, and review the proposed matches.',
      ],
    },
    {
      heading: '5. Complete the first review',
      steps: [
        'Open the Financial Action Center. Work the Fix lane first, then review time-sensitive decisions and approved work.',
        'Open the relevant account and start Reconcile. Enter the statement date and ending balance, then select cleared activity until the difference is zero.',
        'Open Data Health and resolve any unbalanced transactions, stale prices, or structural warnings.',
      ],
    },
    {
      heading: 'What to do next',
      bullets: [
        'Adopt a scenario into the Living Financial Plan and review upcoming events on the Money Timeline.',
        'Create scheduled transactions for predictable bills and income.',
        'Configure budgets, contribution limits, investment lots, or business modules only when the underlying workflow is relevant.',
        'Return to the Action Center weekly and reconcile cash accounts whenever a statement closes.',
      ],
    },
  ],
};

export const GUIDE_PAGES: DocPage[] = [
  {
    slug: 'weekly-review',
    title: 'How to run a five-minute weekly financial review',
    summary: 'Triage issues, decisions, and approved work from one evidence-backed inbox.',
    kind: 'guide',
    readTime: '6 min',
    sections: [
      {
        heading: 'Prerequisites',
        bullets: [
          'At least one book with recent transactions',
          'Imported data reviewed for duplicates and transfer matches',
          'Optional bank connections and scheduled jobs allowed to finish',
        ],
      },
      {
        heading: 'Steps',
        steps: [
          'Open Action Center and refresh if the latest imports are not represented.',
          'Work Fix items first: unmatched evidence, failed jobs, data-health findings, and overdue close work.',
          'Review Decide items. Inspect value, urgency, confidence, liquidity, reversibility, and source evidence before accepting an opportunity.',
          'Complete Do items that were already approved. Use previewable commands when an action changes the ledger.',
          'Open the Continuous Close or reconciliation report and confirm that critical cash accounts are verified through their latest statement.',
        ],
      },
      {
        heading: 'Verification',
        paragraphs: [
          'The inbox should contain only intentionally deferred work. Accepted and dismissed outcomes persist, and calculated recommendations should expose “Explain this number” evidence.',
        ],
      },
      {
        heading: 'Troubleshooting',
        bullets: [
          'If an item looks stale, refresh its source connection or report before dismissing it.',
          'If a value cannot be explained, treat it as unresolved rather than executing the recommendation.',
          'If a command preview is not balanced or names an unexpected account, cancel it and fix the underlying configuration.',
        ],
      },
    ],
  },
  {
    slug: 'reconcile-a-statement',
    title: 'How to reconcile an account to a statement',
    summary: 'Match cleared activity to a statement and establish a verified-through date.',
    kind: 'guide',
    readTime: '8 min',
    sections: [
      {
        heading: 'Prerequisites',
        bullets: [
          'The statement closing date and ending balance',
          'All activity through that date entered or imported',
          'The account commodity and opening balance verified',
        ],
      },
      {
        heading: 'Steps',
        steps: [
          'Open the account and choose Reconcile, or upload the statement under Statements for assisted matching.',
          'Enter the statement date and ending balance exactly as printed.',
          'Select every split that cleared by the closing date. A transaction with multiple splits in the account contributes each applicable split.',
          'Investigate the remaining difference. Check missing transactions, duplicate imports, fees, interest, and incorrect opening balances.',
          'Finish only when the difference is zero. The selected splits become reconciled and the account receives a verified-through date.',
        ],
      },
      {
        heading: 'Verification',
        paragraphs: [
          'The reconciliation report should show the new date and improved coverage. Reopening the account should show the completed splits with reconciled status.',
        ],
      },
      {
        heading: 'Troubleshooting',
        bullets: [
          'Do not create a plug transaction merely to force a zero difference.',
          'For investment accounts, reconcile shares and cash in the appropriate subaccounts rather than combining unlike commodities.',
          'If a statement was assigned to the wrong account, change the assignment before finalizing.',
        ],
      },
    ],
  },
  {
    slug: 'receipts-and-documents',
    title: 'How to turn receipts and statements into ledger evidence',
    summary: 'Capture documents, review extraction, match them, and keep the original source attached.',
    kind: 'guide',
    readTime: '7 min',
    sections: [
      {
        heading: 'Steps',
        steps: [
          'Upload a receipt from Receipts, a transaction, mobile camera capture, or an allowed email sender.',
          'Wait for OCR, then review vendor, date, amount, and currency. AI extraction is optional and uses the provider configured for your user.',
          'Inspect suggested transactions and accept only the correct match. Dismissed suggestions remain excluded.',
          'Use the Inbox for unmatched documents and Document Search to find OCR text later.',
          'Administrators can use Re-extract Legacy to upgrade older regex extractions without overwriting reviewed workflow metadata.',
        ],
      },
      {
        heading: 'Verification',
        paragraphs: [
          'The receipt appears on the matched transaction and remains searchable by filename, vendor, or OCR text.',
        ],
      },
      {
        heading: 'Troubleshooting',
        bullets: [
          'If extraction fails, confirm the worker, storage backend, and OCR dependencies are healthy.',
          'If AI is disabled, regex extraction still provides a basic result.',
          'If several transactions have the same amount, use date, account, and merchant evidence before matching.',
        ],
      },
    ],
  },
  {
    slug: 'living-plan-and-timeline',
    title: 'How to turn a scenario into a living financial plan',
    summary: 'Adopt a model, track guardrails and decisions, then compare the plan with actual results.',
    kind: 'guide',
    readTime: '9 min',
    sections: [
      {
        heading: 'Steps',
        steps: [
          'Build alternatives in Scenario Sandbox using the current book as the baseline.',
          'Compare cash flow, net worth, taxes, and long-term outcomes. Inspect assumptions and calculation evidence.',
          'Adopt the selected scenario into the Living Plan. Adoption creates an immutable version rather than rewriting history.',
          'Add life events, milestones, and guardrails that define when the plan needs attention.',
          'Review expected events on the Money Timeline and resolve conflicts such as low liquidity near a large obligation.',
          'Reconcile actual results monthly and record why material variances occurred in the decision journal.',
        ],
      },
      {
        heading: 'Verification',
        paragraphs: [
          'The active plan shows its source scenario and version, adopted events appear on the Money Timeline, and monthly reconciliation retains the previous decisions.',
        ],
      },
    ],
  },
  {
    slug: 'family-office',
    title: 'How to consolidate authorized household and entity books',
    summary: 'Link ownership, inspect consolidated results, and keep permissions and currency limitations explicit.',
    kind: 'guide',
    readTime: '8 min',
    sections: [
      {
        heading: 'Steps',
        steps: [
          'Grant the viewer an appropriate role on every book that should participate. A book link never grants permission by itself.',
          'Create book relationships and ownership percentages under Settings.',
          'Open Family Office and review the ownership graph before relying on consolidated figures.',
          'Inspect net worth, profit and loss, cash flow, investments, and liquidity. Follow evidence links back to the source books.',
          'Review transfer matches and approved presentation eliminations. They change the consolidated presentation, not the underlying ledgers.',
          'Resolve missing exchange rates or accept explicit exclusions; the system will not silently combine unsupported currencies.',
        ],
      },
      {
        heading: 'Verification',
        paragraphs: [
          'Only books the viewer can already access appear. Consolidated values identify exclusions, ownership look-through, and source evidence.',
        ],
      },
    ],
  },
  {
    slug: 'business-cash-cycle',
    title: 'How to follow work from estimate to collected cash',
    summary: 'Connect estimates, jobs, invoices, payment links, costs, and employee reimbursements.',
    kind: 'guide',
    readTime: '10 min',
    sections: [
      {
        heading: 'Steps',
        steps: [
          'Create the customer and job, then record billable time, rates, vendor costs, and explicitly linked expenses.',
          'Send an estimate and record acceptance, or convert it directly to an invoice when appropriate.',
          'Post the invoice and share its public link. A configured Stripe connection can accept payment and post processor fees from signed webhooks.',
          'Review job profitability for invoiced revenue, collections, labor cost, WIP, linked costs, gross profit, and margin.',
          'Have employees submit receipt-backed expenses. Approvers preview approval or rejection; approval creates a draft voucher.',
          'Use AR/AP aging, dunning, the Action Center, and the Money Timeline to follow overdue collections and reimbursement due dates.',
        ],
      },
      {
        heading: 'Verification',
        paragraphs: [
          'The job report ties revenue and cost back to source documents, payment history appears on the invoice, and posted vouchers advance reimbursement status.',
        ],
      },
    ],
  },
  {
    slug: 'investment-tax-review',
    title: 'How to review investments before making a tax-sensitive trade',
    summary: 'Validate lots and prices, identify opportunities, and inspect the tax consequence before trading.',
    kind: 'guide',
    readTime: '9 min',
    sections: [
      {
        heading: 'Steps',
        steps: [
          'Open Data Health and resolve stale prices, missing commodities, and unbalanced investment transactions.',
          'Review Investment Lots and assign or scrub unassigned sales using the cost-basis method appropriate to the account.',
          'Open the portfolio and benchmark reports to separate contributions from investment performance.',
          'Use Tax-Loss Harvesting or Sell Planner to compare candidate lots, holding periods, realized gains, and wash-sale warnings.',
          'Inspect the calculation trace and Form 8949 classification before entering a trade in the ledger.',
          'After posting, refresh Capital Gains and reconcile it with broker tax documents.',
        ],
      },
      {
        heading: 'Verification',
        paragraphs: [
          'Sold quantities are fully assigned, realized gains are balanced, and the Capital Gains report links each tax lot to its source transaction.',
        ],
      },
    ],
  },
];

export const RELEASE_ONE_DOCS: DocPage[] = [GETTING_STARTED, ...GUIDE_PAGES];

export function docsSearchEntries(): DocSearchEntry[] {
  return [
    {
      title: 'Documentation home',
      summary: 'Choose a workflow, learn the core model, or find a feature.',
      href: '/docs',
      category: 'Start here',
      keywords: 'help manual documentation',
    },
    ...RELEASE_ONE_DOCS.map((page) => ({
      title: page.title,
      summary: page.summary,
      href: page.kind === 'tutorial' ? '/docs/getting-started' : `/docs/guides/${page.slug}`,
      category: page.kind === 'tutorial' ? 'Tutorial' : 'How-to guide',
      keywords: page.sections.flatMap((section) => [
        section.heading,
        ...(section.bullets ?? []),
        ...(section.steps ?? []),
      ]).join(' '),
    })),
    {
      title: 'Complete feature catalog',
      summary: 'Browse every registered page, report, tool, and action.',
      href: '/features',
      category: 'Reference',
      keywords: 'all features tools reports pages catalog',
    },
    {
      title: 'API reference',
      summary: 'Interactive OpenAPI reference for integrations and scripts.',
      href: '/docs/api',
      category: 'Reference',
      keywords: 'swagger openapi endpoints token integration',
    },
  ];
}

export function guideBySlug(slug: string): DocPage | undefined {
  return GUIDE_PAGES.find((page) => page.slug === slug);
}
