/**
 * /settings/api-docs — reference for the public REST API surface.
 *
 * Server component, static content. Documents authentication with personal
 * access tokens (Settings → API Tokens) and the stable endpoints most useful
 * to scripts and automation tools. Linked from the API Tokens settings
 * section. Only endpoints that actually exist are documented here — keep it
 * that way when adding entries.
 */

import Link from 'next/link';

export const metadata = {
    title: 'API Documentation — GnuCash Web',
};

interface Param {
    name: string;
    description: string;
}

interface Endpoint {
    method: 'GET' | 'POST';
    path: string;
    role: 'readonly' | 'edit';
    description: string;
    params?: Param[];
    body?: Param[];
    example?: string;
}

interface EndpointGroup {
    title: string;
    blurb?: string;
    endpoints: Endpoint[];
}

const BASE = 'https://your-server.example.com';
const TOKEN = 'gcw_0123456789abcdef0123456789abcdef';

const GROUPS: EndpointGroup[] = [
    {
        title: 'Books & Features',
        endpoints: [
            {
                method: 'GET',
                path: '/api/books',
                role: 'readonly',
                description: 'List the books you have access to (guid, name, description, account count).',
                example: `curl -H "Authorization: Bearer ${TOKEN}" ${BASE}/api/books`,
            },
            {
                method: 'GET',
                path: '/api/book-features',
                role: 'readonly',
                description: "Feature modules enabled for the token's book (membership, compliance, invoicing, ...).",
            },
        ],
    },
    {
        title: 'Accounts',
        endpoints: [
            {
                method: 'GET',
                path: '/api/accounts',
                role: 'readonly',
                description: 'Account hierarchy of the active book with balances.',
                params: [
                    { name: 'flat', description: "'true' returns a flat array instead of a tree" },
                    { name: 'startDate / endDate', description: 'ISO dates — balance window' },
                    { name: 'noBalances', description: "'true' skips balance computation (faster)" },
                ],
                example: `curl -H "Authorization: Bearer ${TOKEN}" "${BASE}/api/accounts?flat=true"`,
            },
            {
                method: 'GET',
                path: '/api/accounts/{guid}/transactions',
                role: 'readonly',
                description: 'Ledger for one account with running balance.',
                params: [
                    { name: 'limit / offset', description: 'pagination (default 100 / 0)' },
                    { name: 'startDate / endDate', description: 'ISO date filters' },
                    { name: 'search', description: 'description / num / account-name search; #tag tokens filter by tag' },
                    { name: 'includeSubaccounts', description: "'true' folds child accounts into the ledger" },
                ],
            },
        ],
    },
    {
        title: 'Transactions',
        endpoints: [
            {
                method: 'GET',
                path: '/api/transactions',
                role: 'readonly',
                description: 'Paginated transaction list with splits, scoped to the book.',
                params: [
                    { name: 'limit / offset', description: 'pagination (default 100 / 0)' },
                    { name: 'search', description: 'description / num / account-name search; #tag tokens filter by tag' },
                    { name: 'startDate / endDate', description: 'ISO date filters' },
                    { name: 'accountTypes', description: 'comma-separated (e.g. ASSET,EXPENSE)' },
                    { name: 'minAmount / maxAmount', description: 'absolute amount range' },
                    { name: 'reconcileStates', description: 'comma-separated: n, c, y' },
                ],
                example: `curl -H "Authorization: Bearer ${TOKEN}" "${BASE}/api/transactions?limit=20&search=groceries"`,
            },
            {
                method: 'POST',
                path: '/api/transactions',
                role: 'edit',
                description: 'Create a transaction with full split control (multi-split, multi-currency). Respects the period lock.',
                body: [
                    { name: 'currency_guid', description: 'commodity GUID of the transaction currency' },
                    { name: 'post_date', description: 'ISO date' },
                    { name: 'description', description: 'transaction description' },
                    { name: 'splits[]', description: 'each: account_guid, value_num, value_denom, quantity_num, quantity_denom, memo?; values must sum to zero' },
                ],
            },
        ],
    },
    {
        title: 'Reports',
        blurb: 'All report endpoints are read-only and return JSON scoped to the book.',
        endpoints: [
            {
                method: 'GET',
                path: '/api/reports/balance-sheet',
                role: 'readonly',
                description: 'Balance sheet as of endDate.',
                params: [
                    { name: 'startDate / endDate', description: 'ISO dates' },
                    { name: 'compareToPrevious', description: "'true' adds a prior-period column" },
                    { name: 'showZeroBalances', description: "'true' keeps zero-balance accounts" },
                ],
            },
            {
                method: 'GET',
                path: '/api/reports/income-statement',
                role: 'readonly',
                description: 'Profit & loss for the date range.',
                params: [
                    { name: 'startDate / endDate', description: 'ISO dates' },
                    { name: 'basis', description: "'accrual' (default) or 'cash'" },
                    { name: 'compareToPrevious', description: "'true' adds a prior-period column" },
                ],
                example: `curl -H "Authorization: Bearer ${TOKEN}" "${BASE}/api/reports/income-statement?startDate=2026-01-01&endDate=2026-06-30&basis=cash"`,
            },
            {
                method: 'GET',
                path: '/api/reports/contribution-summary',
                role: 'readonly',
                description: 'Retirement contribution report with IRS limit tracking.',
                params: [
                    { name: 'startDate / endDate', description: 'ISO dates' },
                    { name: 'groupBy', description: "'calendar_year' (default) or 'tax_year'" },
                ],
            },
        ],
    },
    {
        title: 'Receipts',
        endpoints: [
            {
                method: 'POST',
                path: '/api/receipts/upload',
                role: 'edit',
                description: 'Upload one or more receipt files (multipart/form-data). Optionally attach to a transaction.',
                body: [
                    { name: 'files', description: 'one or more file parts' },
                    { name: 'transaction_guid', description: 'optional — attach to an existing transaction' },
                ],
                example: `curl -H "Authorization: Bearer ${TOKEN}" -F "files=@receipt.jpg" ${BASE}/api/receipts/upload`,
            },
        ],
    },
    {
        title: 'Membership (501c3 books)',
        blurb: 'Available when the membership feature module is enabled for the book.',
        endpoints: [
            {
                method: 'GET',
                path: '/api/membership/members',
                role: 'readonly',
                description: 'List members with dues status and paid-through dates.',
            },
            {
                method: 'GET',
                path: '/api/membership/summary',
                role: 'readonly',
                description: 'Membership headline numbers (counts by status, dues collected).',
            },
            {
                method: 'POST',
                path: '/api/membership/members/{id}/payments',
                role: 'edit',
                description: "Record a dues payment; the coverage period derives from the member's membership type.",
                body: [
                    { name: 'paidDate', description: 'ISO date (required)' },
                    { name: 'amount', description: "optional — defaults to the membership type's dues amount" },
                    { name: 'method', description: 'cash | check | card | zeffy | other' },
                    { name: 'reference / notes', description: 'optional strings' },
                ],
            },
        ],
    },
    {
        title: 'Compliance & Scheduled Transactions',
        endpoints: [
            {
                method: 'GET',
                path: '/api/compliance',
                role: 'readonly',
                description: 'Compliance calendar items for the book and year.',
                params: [{ name: 'year', description: 'four-digit year (defaults to current)' }],
            },
            {
                method: 'GET',
                path: '/api/scheduled-transactions',
                role: 'readonly',
                description: 'Scheduled transactions with recurrence and next-occurrence info.',
                params: [{ name: 'enabled', description: "'true' returns only enabled schedules" }],
            },
        ],
    },
    {
        title: 'Inbound Webhooks',
        blurb:
            'Convenience endpoints for automation tools (n8n, Home Assistant, shell scripts). ' +
            'Same bearer-token authentication as everything else; both respect the period lock. ' +
            'See docs/n8n-recipes.md in the repository for worked n8n examples.',
        endpoints: [
            {
                method: 'POST',
                path: '/api/webhooks/inbound/transaction',
                role: 'edit',
                description:
                    "Create a simple two-split transaction: amount moves FROM one account TO another. Both accounts must be currency accounts in the token's book.",
                body: [
                    { name: 'date', description: 'ISO date (YYYY-MM-DD)' },
                    { name: 'description', description: 'transaction description' },
                    { name: 'amount', description: 'positive number in book currency' },
                    { name: 'fromAccountGuid', description: 'account credited (money out)' },
                    { name: 'toAccountGuid', description: 'account debited (money in)' },
                ],
                example:
                    `curl -X POST -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \\\n` +
                    `  -d '{"date":"2026-07-15","description":"Coffee","amount":4.75,"fromAccountGuid":"<checking-guid>","toAccountGuid":"<expense-guid>"}' \\\n` +
                    `  ${BASE}/api/webhooks/inbound/transaction`,
            },
            {
                method: 'POST',
                path: '/api/webhooks/inbound/membership-payment',
                role: 'edit',
                description: 'Record a membership dues payment for an existing member.',
                body: [
                    { name: 'memberId', description: 'numeric member id' },
                    { name: 'paidDate', description: 'ISO date (YYYY-MM-DD)' },
                    { name: 'amount', description: "optional — defaults to the membership type's dues amount" },
                    { name: 'method', description: 'cash | check | card | zeffy | other (default other)' },
                    { name: 'reference', description: 'optional external reference (e.g. processor id)' },
                ],
                example:
                    `curl -X POST -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \\\n` +
                    `  -d '{"memberId":42,"paidDate":"2026-07-15","amount":50,"method":"zeffy","reference":"ZFY-1234"}' \\\n` +
                    `  ${BASE}/api/webhooks/inbound/membership-payment`,
            },
        ],
    },
];

function MethodBadge({ method }: { method: 'GET' | 'POST' }) {
    return (
        <span
            className={`inline-block px-1.5 py-0.5 rounded text-xs font-mono font-semibold ${
                method === 'GET'
                    ? 'bg-secondary-light text-secondary'
                    : 'bg-primary-light text-primary'
            }`}
        >
            {method}
        </span>
    );
}

function RoleBadge({ role }: { role: 'readonly' | 'edit' }) {
    return (
        <span
            className={`inline-block px-1.5 py-0.5 rounded text-[10px] ${
                role === 'edit'
                    ? 'bg-warning/10 text-warning'
                    : 'bg-surface-hover text-foreground-secondary'
            }`}
        >
            {role}
        </span>
    );
}

function ParamList({ title, params }: { title: string; params: Param[] }) {
    return (
        <div className="mt-2">
            <div className="text-[10px] uppercase tracking-wide text-foreground-muted mb-1">{title}</div>
            <div className="space-y-0.5">
                {params.map(p => (
                    <div key={p.name} className="flex gap-2 text-xs">
                        <code className="font-mono text-foreground shrink-0">{p.name}</code>
                        <span className="text-foreground-secondary">{p.description}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function EndpointCard({ endpoint }: { endpoint: Endpoint }) {
    return (
        <div className="border border-border rounded-lg p-4 bg-surface">
            <div className="flex items-center gap-2 flex-wrap">
                <MethodBadge method={endpoint.method} />
                <code className="font-mono text-sm text-foreground">{endpoint.path}</code>
                <RoleBadge role={endpoint.role} />
            </div>
            <p className="mt-2 text-sm text-foreground-secondary">{endpoint.description}</p>
            {endpoint.params && <ParamList title="Query parameters" params={endpoint.params} />}
            {endpoint.body && <ParamList title="Body" params={endpoint.body} />}
            {endpoint.example && (
                <pre className="mt-3 p-3 bg-background rounded-md border border-border overflow-x-auto text-xs font-mono text-foreground-secondary whitespace-pre">
                    {endpoint.example}
                </pre>
            )}
        </div>
    );
}

export default function ApiDocsPage() {
    return (
        <div className="max-w-4xl mx-auto px-6 py-8 space-y-10">
            <div>
                <h1 className="text-2xl font-bold text-foreground">API Documentation</h1>
                <p className="mt-1 text-sm text-foreground-secondary">
                    The REST API used by the app itself, callable from scripts and integrations with a
                    personal access token. Manage tokens in{' '}
                    <Link href="/settings" className="text-primary hover:underline">
                        Settings → API Tokens
                    </Link>
                    .
                </p>
            </div>

            <section className="space-y-3">
                <h2 className="text-lg font-semibold text-foreground">Authentication</h2>
                <p className="text-sm text-foreground-secondary">
                    Send a personal access token as a Bearer token in the{' '}
                    <code className="px-1 py-0.5 bg-surface-hover rounded text-xs font-mono">Authorization</code>{' '}
                    header. Tokens look like{' '}
                    <code className="px-1 py-0.5 bg-surface-hover rounded text-xs font-mono">gcw_</code> + 32 hex
                    characters and are shown exactly once at creation.
                </p>
                <pre className="p-3 bg-background rounded-md border border-border overflow-x-auto text-xs font-mono text-foreground-secondary">
                    {`curl -H "Authorization: Bearer ${TOKEN}" \\\n     ${BASE}/api/accounts`}
                </pre>
                <ul className="text-sm text-foreground-secondary list-disc pl-5 space-y-1">
                    <li>
                        A token carries a role — <em>readonly</em> or <em>edit</em> — and its effective role is
                        capped at your own role for the book. Tokens can never grant <em>admin</em>.
                    </li>
                    <li>
                        <strong className="text-foreground">Book scoping:</strong> every request is scoped to the
                        token&apos;s book (the book that was active when the token was created). Data from other
                        books is never returned or modified.
                    </li>
                    <li>
                        Invalid, expired, and revoked tokens return <code className="font-mono text-xs">401</code>;
                        insufficient role returns <code className="font-mono text-xs">403</code>. Mutations dated
                        into a locked accounting period return <code className="font-mono text-xs">400</code> with
                        code <code className="font-mono text-xs">PERIOD_LOCKED</code>.
                    </li>
                    <li>
                        Token management endpoints reject token authentication — a leaked token cannot mint more
                        tokens.
                    </li>
                </ul>
            </section>

            {GROUPS.map(group => (
                <section key={group.title} className="space-y-3">
                    <h2 className="text-lg font-semibold text-foreground">{group.title}</h2>
                    {group.blurb && <p className="text-sm text-foreground-secondary">{group.blurb}</p>}
                    <div className="space-y-3">
                        {group.endpoints.map(endpoint => (
                            <EndpointCard key={`${endpoint.method} ${endpoint.path}`} endpoint={endpoint} />
                        ))}
                    </div>
                </section>
            ))}

            <section className="space-y-2 pb-8">
                <h2 className="text-lg font-semibold text-foreground">Notes</h2>
                <ul className="text-sm text-foreground-secondary list-disc pl-5 space-y-1">
                    <li>
                        Amounts in the GnuCash data model are fractions (<code className="font-mono text-xs">value_num / value_denom</code>).
                        List endpoints also return <code className="font-mono text-xs">value_decimal</code> strings for convenience.
                    </li>
                    <li>
                        Income accounts follow GnuCash sign conventions: money earned appears as negative split values.
                    </li>
                    <li>
                        Additional endpoints exist for nearly every feature in the app; the ones above are the
                        stable, most useful surface for integrations.
                    </li>
                </ul>
            </section>
        </div>
    );
}
