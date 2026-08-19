# Folio

A self-hosted personal and small-business finance platform with full double-entry accounting, served from your own PostgreSQL database. Compatible with GnuCash desktop for import and export. Built with Next.js 16, React 19, and TypeScript.

## Features

**Accounts & Transactions**
- Account hierarchy with expandable tree, sorting, filtering, and recursive balance aggregation
- Transaction journal with infinite scroll, search, and color-coded split breakdowns
- Account editing with notes, tax-related flag, retirement account classification, and reparenting
- SimpleFin bank import with reconciliation matching and transfer dedup

**Scheduled Transactions**
- View all scheduled transactions with recurrence display and upcoming occurrences
- Execute or skip individual occurrences, creating real transactions from templates
- "Since Last Run" batch mode to process all overdue occurrences at once
- Enable/disable toggle and create new scheduled transactions with full template support
- Edit schedules or create one from an existing ledger transaction through a previewed, auditable command
- Mortgage-linked transactions compute dynamic principal/interest splits

**Investment Management**
- Investment portfolio with market value, cost basis, and gain/loss
- Lot-level tracking with realized/unrealized gains, holding periods, and tax-loss harvesting
- Auto-lot assignment (FIFO/LIFO/average) with an automatic lot scrub engine
- Cost basis tracing across account transfers

**Reports & Analysis**
- 35+ report types: balance sheet, income statement, cash flow, trial balance, general journal/ledger, and more
- Contribution summary with IRS limit tracking, tax-year attribution, and progress bars
- Net worth and income/expense charts
- Mortgage payoff calculator with amortization schedule
- FIRE calculator with savings rate and projection
- Farm & Apiary Analyzer: side-by-side tax comparison of four ways to handle home-farm income (hobby, Schedule F, Schedule F + NC LLC), fed by your actual book data
- Schedule F report mapping farm income/expense accounts onto IRS lines, with a farm chart of accounts for books labeled "Farm or ranch" and farm deadlines on the compliance calendar

**Financial Action & Evidence**
- Financial Action Center with ranked Fix, Decide, and Do lanes for a five-minute weekly close
- Eight deterministic opportunity packs for taxes, contributions, debt, cash reserves, portfolios, tax strategy, subscriptions, and budget gaps
- “Explain this number” calculation traces with source evidence, assumptions, stale-data warnings, and accountant-ready manifest export
- Keyboard triage, mobile swipe actions, batch operations, durable accept/dismiss outcomes, and per-book verified-through dates
- Safe Operator commands with balanced previews, explicit approval, audit history, bounded undo, and evidence links
- Continuous Close coverage with stale-account actions and reconciliation time/interaction metrics

**Planning & Family Office**
- Unified Money Timeline for scheduled cash, deadlines, renewals, invoices, home tasks, goals, equity vesting, and adopted plan events, with conflict detection and filtered iCal feeds
- Living Financial Plan that adopts Scenario Sandbox models, versions life events and guardrails, reconciles monthly actuals, explains variances, and retains a decision journal
- Permission-safe Family Office for ownership-aware cross-book net worth, P&L, cash flow, investments, liquidity, transfer eliminations, documents, actions, timeline events, and Ask Your Books
- Explicit FX conversion and exclusion warnings keep consolidated figures honest when linked books use different currencies

**Business Operations**
- Job profitability combining invoiced revenue, collections, labor cost, WIP, linked expenses, gross profit, and margin alerts
- Employee receipt reimbursement with submitted, approved, voucher-posted, and rejected states
- Stripe payment links and signed webhook posting for invoice payments and processing fees; public customers can also review payment history and accept or decline estimates

**Infrastructure**
- Progressive Web App (installable on phone/desktop)
- Docker Compose with PostgreSQL, Redis, and optional MinIO for S3 storage
- Background job processing via BullMQ worker
- Receipt upload with AI-powered extraction (OpenAI, Anthropic, or Ollama)

## 🚀 Getting Started

The public [documentation site](http://localhost:3000/docs) starts with a
book-to-weekly-review tutorial and task-oriented guides for reconciliation,
document evidence, planning, Family Office, business cash flow, and investment
tax review. It also includes searchable reference guidance for every registered
feature, financial concepts, self-hosting administration and recovery, plus
route-aware Help links inside the application. The interactive OpenAPI reference is available at
[http://localhost:3000/docs/api](http://localhost:3000/docs/api).

### Prerequisites

- [Node.js 20+](https://nodejs.org/) (Project uses Volta for version pinning)
- A PostgreSQL database using the [GnuCash-compatible core schema](https://www.gnucash.org/docs/v5/mobile-man/gnc-database-architecture.html) (an existing GnuCash PostgreSQL database works as-is).

### Environment Variables

Copy `.env.example` to `.env.local` and fill in your values:

```bash
cp .env.example .env.local
```

Required: `DATABASE_URL`, `NEXTAUTH_SECRET`, `REDIS_URL`. See `.env.example` for all options including AI, S3, and Docker Compose variables.

**Optional OIDC single sign-on**: set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (and optionally `OIDC_PROVIDER_NAME`) to add a "Sign in with ..." button alongside password login (authorization code + PKCE; tested with Pocket ID). Register `{NEXTAUTH_URL}/api/auth/oidc/callback` as the redirect URL. Existing password accounts are matched by verified email on first SSO login, or can be linked manually from the Profile page. New SSO users start with read-only access; admins assign roles (readonly/edit/admin) under Settings → Users.

### Development

```bash
npm install
npx prisma generate
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the app.

### Production (Local)

```bash
npm run build
npm run start
```

## 🧪 Testing

The suite is split into tiers by filename. They do not overlap, and CI runs
each as a separate step so a failure names the tier that broke.

| Command | Runs | Needs a database |
| --- | --- | --- |
| `npm run test:run` | everything except `*.integration.test.ts` | no |
| `npm run test:coverage` | the same unit tier, with v8 coverage + thresholds | no |
| `npm run test:integration` | only `*.integration.test.ts` | yes |
| `npm run test:e2e` | `tests/e2e/*.spec.ts` through a real browser | yes |

The first three run on every push to `main` and every pull request
(`.github/workflows/deploy.yml`). The end-to-end tier does not - see below.

### Unit tier

```bash
npm run test:run        # or `npm test` for watch mode
```

Runs in jsdom with mocked data access. No environment setup, no database.

### Integration tier

These tests talk to a real PostgreSQL server, because the guarantees they
cover — `FOR UPDATE`, lock ordering, advisory locks — are only observable
across two live connections and cannot be asserted against a mocked pool.

`locking.integration.test.ts` is the tier's substance: it holds a lock on one
connection, invokes application code on another, and reads `pg_locks` from a
third to prove the application backend is genuinely blocked before the holder
releases. Deleting the advisory lock from `src/lib/db.ts`, the `FOR UPDATE`
from `lockTransactionsForUpdate`, or the atomic claim from
`webhook-idempotency.ts` each turns the matching test red.

These tests write rows. The tier does not create a per-run schema and never
truncates, so a test that writes must delete its own rows in `afterAll` —
see the TEST DATA section of `vitest.integration.config.ts`.

```bash
# 1. Put the URL of a THROWAWAY, EMPTY database in .env.test.local at the repo
#    root. That filename is gitignored; never commit credentials.
echo 'TEST_DATABASE_URL=postgresql://user:password@localhost:5432/gnucash_test' > .env.test.local

# 2. Create the schema. Once per database — see below; not re-runnable.
npm run test:integration:schema

# 3. Run the tier. This one IS re-runnable, as often as you like.
npm run test:integration
```

Use a database you are willing to lose. The harness overwrites `DATABASE_URL`
with `TEST_DATABASE_URL` for the duration of the run, so application code under
test writes there and cannot reach a real book.

`test:integration:schema` does two things, and both are required: `prisma db
push` creates the tables modelled in `prisma/schema.prisma`, then
`initializeDatabase()` creates the `account_hierarchy` view and the extension
tables that exist only as idempotent DDL in `src/lib/db-init.ts`. A further set
of tables is created lazily by per-feature `ensureXTable()` helpers the first
time a feature is used, exactly as in production.

**Step 2 wants an empty database and cannot be re-run against a provisioned
one.** `initializeDatabase()` creates 20 tables that `prisma/schema.prisma` does
not model, so on a second run `prisma db push` reads them as drift and asks to
drop them — and refuses, because by then they hold rows. The refusal is the
correct outcome and is left in place on purpose: `--accept-data-loss` would make
a mistyped `TEST_DATABASE_URL` destructive. To re-provision, drop and recreate
the database and run step 2 again. CI never hits this, since its `postgres`
service container is new for every job.

**If `TEST_DATABASE_URL` is missing, the tier fails with instructions — it does
not skip.** A skipped tier reports green while asserting nothing, which reads
as coverage that does not exist. In CI the `quality` job's `postgres` service
supplies the variable.

### Coverage

`npm run test:coverage` is the same single run as `test:run` with v8
instrumentation, and it is what CI executes. `vitest.config.ts` carries
per-metric thresholds set a few points below the measured numbers: they are a
**regression floor**, not a target. A build goes red when a body of tests is
deleted or bypassed, not when one new file lands uncovered. Raise the floors
when the real numbers move up; never lower them to make a build pass. CI
archives `coverage/lcov.info` and `coverage/coverage-summary.json` as an
artifact, including on a failed run.

### End-to-end tier (Playwright)

`tests/e2e/` drives a real Chromium against a built, running app: the install
surface (manifest, icons, offline shell) and, optionally, a seeded ledger.

```bash
# 1. A throwaway database with the schema, exactly as for the integration tier.
echo 'TEST_DATABASE_URL=postgresql://user:password@localhost:5432/gnucash_e2e' > .env.test.local
npm run test:integration:schema

# 2. Build once - the suite runs `npm run start`, not `next dev`.
npm run build

# 3. Run. playwright.config.ts starts the server on 127.0.0.1:3010 itself.
npm run test:e2e
npm run test:e2e:ui      # the Playwright UI runner, for debugging a failure
```

`npm run start` needs `DATABASE_URL` and a `SESSION_SECRET` of at least 32
characters in your environment or `.env.local`.

Two knobs:

- `E2E_BASE_URL` - point the suite at an already-running app (staging, a
  container) instead of letting Playwright start one.
- `RUN_LEDGER_E2E=1` plus `E2E_USER` / `E2E_PASS` - include
  `review-mode.spec.ts`, which needs a seeded private book. It is excluded by
  default and skips itself when the credentials are absent. **Credentials come
  from the environment only; never commit them.**

This tier is not on the push/PR workflow: provisioning a database, building,
downloading a browser and booting a server costs minutes of runner time for a
suite that changes far less often than the code it covers. It has its own
`.github/workflows/e2e.yml`, run on demand (**Actions -> End-to-end
(Playwright) -> Run workflow**) and weekly on Mondays.

## 🐳 Docker

The project includes a multi-stage Docker build that generates a highly optimized `standalone` bundle.

### Docker Compose (recommended)

```bash
cp .env.example .env
# Edit .env with your values
docker compose -f docker-compose.prod.yml up -d
```

Includes PostgreSQL, Redis, app, worker, and Watchtower for auto-updates.

`POSTGRES_PASSWORD` is required for the production Compose stack. On a new
install, generate a unique value with `openssl rand -base64 32`. On an existing
database volume, set it to the password used when PostgreSQL was initialized;
changing only the environment value will not rotate the database password. To
rotate, run `ALTER ROLE gnucash PASSWORD '<new-password>'` inside PostgreSQL,
then update the environment value and recreate the app and worker containers.
PostgreSQL is mapped to `127.0.0.1` for host-local tooling only. Use SSH
port-forwarding for remote access, and remove the mapping once local tooling
no longer needs it.

### Standalone

```bash
docker build -t folio .
docker run -p 3000:3000 -e DATABASE_URL="your_db_url" folio
```

## 🛠️ Tech Stack

- **Framework**: [Next.js 16](https://nextjs.org/) (App Router)
- **UI**: React 19, [Tailwind CSS](https://tailwindcss.com/)
- **Database**: PostgreSQL via [Prisma](https://www.prisma.io/)
- **Queue**: [BullMQ](https://docs.bullmq.io/) + Redis
- **Testing**: [Vitest](https://vitest.dev/) (3,300+ tests)
- **Auth**: iron-session + bcrypt, optional OIDC SSO (openid-client)
- **Typing**: TypeScript

## 📄 License

This project is open-source and intended for personal use. GnuCash import/export compatibility is maintained; not affiliated with the GnuCash project.
