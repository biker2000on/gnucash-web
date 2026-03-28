# GnuCash Web PWA

A Progressive Web App for managing GnuCash financial data. Read and write access to your GnuCash PostgreSQL database from any device. Built with Next.js 16, React 19, and TypeScript.

## Features

**Accounts & Transactions**
- Account hierarchy with expandable tree, sorting, filtering, and recursive balance aggregation
- Transaction journal with infinite scroll, search, and color-coded split breakdowns
- Account editing with notes, tax-related flag, retirement account classification, and reparenting
- SimpleFin bank import with reconciliation matching and transfer dedup

**Scheduled Transactions**
- View all scheduled transactions with recurrence display and upcoming occurrences
- Execute or skip individual occurrences, creating real GnuCash transactions from templates
- "Since Last Run" batch mode to process all overdue occurrences at once
- Enable/disable toggle and create new scheduled transactions with full GnuCash template compatibility
- Mortgage-linked transactions compute dynamic principal/interest splits

**Investment Management**
- Investment portfolio with market value, cost basis, and gain/loss
- Lot-level tracking with realized/unrealized gains, holding periods, and tax-loss harvesting
- Auto-lot assignment (FIFO/LIFO/average) with GnuCash-compatible lot scrub engine
- Cost basis tracing across account transfers

**Reports & Analysis**
- 16+ report types: balance sheet, income statement, cash flow, trial balance, general journal/ledger, and more
- Contribution summary with IRS limit tracking, tax-year attribution, and progress bars
- Net worth and income/expense charts
- Mortgage payoff calculator with amortization schedule
- FIRE calculator with savings rate and projection

**Infrastructure**
- Progressive Web App (installable on phone/desktop)
- Docker Compose with PostgreSQL, Redis, and optional MinIO for S3 storage
- Background job processing via BullMQ worker
- Receipt upload with AI-powered extraction (OpenAI, Anthropic, or Ollama)

## 🚀 Getting Started

### Prerequisites

- [Node.js 20+](https://nodejs.org/) (Project uses Volta for version pinning)
- A PostgreSQL database with a [GnuCash schema](https://www.gnucash.org/docs/v5/mobile-man/gnc-database-architecture.html).

### Environment Variables

Copy `.env.example` to `.env.local` and fill in your values:

```bash
cp .env.example .env.local
```

Required: `DATABASE_URL`, `NEXTAUTH_SECRET`, `REDIS_URL`. See `.env.example` for all options including AI, S3, and Docker Compose variables.

### Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the app.

### Production (Local)

```bash
npm run build
npm run start
```

## 🐳 Docker

The project includes a multi-stage Docker build that generates a highly optimized `standalone` bundle.

### Docker Compose (recommended)

```bash
cp .env.example .env
# Edit .env with your values
docker compose -f docker-compose.prod.yml up -d
```

Includes PostgreSQL, Redis, app, worker, and Watchtower for auto-updates.

### Standalone

```bash
docker build -t gnucash-web .
docker run -p 3000:3000 -e DATABASE_URL="your_db_url" gnucash-web
```

## 🛠️ Tech Stack

- **Framework**: [Next.js 16](https://nextjs.org/) (App Router)
- **UI**: React 19, [Tailwind CSS](https://tailwindcss.com/)
- **Database**: PostgreSQL via [Prisma](https://www.prisma.io/)
- **Queue**: [BullMQ](https://docs.bullmq.io/) + Redis
- **Testing**: [Vitest](https://vitest.dev/) (227 tests)
- **Auth**: NextAuth.js
- **Typing**: TypeScript

## 📄 License

This project is open-source and intended for personal use with GnuCash data.
