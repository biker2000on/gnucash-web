# GnuCash Web

## What This Is

A Progressive Web App for managing GnuCash financial data, extending from read-only viewing to full transaction management with automated bank transaction imports via Plaid. Built with Next.js, React, TypeScript, and Prisma, designed to be self-hosted while maintaining full compatibility with the GnuCash desktop application.

## Core Value

Enable full transaction management and automated bank imports while preserving GnuCash desktop compatibility - the database must remain usable by GnuCash desktop at all times.

## Requirements

### Validated

- ✓ Account hierarchy browsing with expandable tree — existing
- ✓ Account ledger view with running balances and infinite scroll — existing
- ✓ General ledger (all transactions) with search — existing
- ✓ Multi-currency formatting — existing
- ✓ PostgreSQL backend connection — existing
- ✓ Progressive Web App with offline capability — existing

### Active

**Foundation (Pre-Feature Work)**
- [ ] Migrate from direct pg queries to Prisma ORM
- [ ] Set up comprehensive testing infrastructure (API routes, business logic, component tests)

**Phase 1: Enhanced Transaction Journal**
- [ ] Configurable date filtering (remove hardcoded 2026-01-01)
- [ ] Advanced transaction filtering (account type, amount range, reconciliation status)
- [ ] Transaction details modal
- [ ] Transaction CRUD operations (create, edit, delete)
- [ ] Reconciliation workflow

**Phase 2: Enhanced Account Hierarchy**
- [ ] Account CRUD operations
- [ ] Account hierarchy reorganization (drag-drop)
- [ ] Account actions menu
- [ ] Account type aggregations (summary cards)

**Phase 3: Budgeting System**
- [ ] Budget list and management
- [ ] Budget editor (spreadsheet-style)
- [ ] Budget vs Actual view
- [ ] Budget reports

**Phase 4: Reporting System**
- [ ] Report framework
- [ ] Balance Sheet
- [ ] Income Statement (Profit & Loss)
- [ ] Cash Flow Statement
- [ ] Transaction reports
- [ ] Chart visualizations
- [ ] Report export (PDF, CSV, Excel)

**Phase 5: Supporting Features**
- [ ] Investment account support (commodity valuation, price lookups)
- [ ] Multi-currency support (currency chain traversal)
- [ ] User authentication (local, self-hosted)
- [ ] Data validation & integrity checks
- [ ] Audit trail

**Phase 6: Plaid Integration**
- [ ] Plaid account linking (separate extension table)
- [ ] Direct transaction import to linked accounts
- [ ] Sync scheduling (manual, daily, weekly)
- [ ] On-revisit sync trigger (if >1 day since last sync)

### Out of Scope

- Modifying existing GnuCash tables — must maintain desktop compatibility
- External authentication providers (OAuth, social login) — self-hosted only
- Cloud-hosted deployment options — self-hosted only
- Mobile native apps — PWA covers mobile needs
- Real-time multi-user collaboration — single-user focus for v1
- External analytics/monitoring services — self-hosted only

## Context

**Existing Codebase:**
- Next.js 16.1.1 with App Router pattern
- React 19.2.3 with TypeScript 5.x
- Direct PostgreSQL via `pg` driver (no ORM)
- No testing framework currently configured
- PWA enabled via next-pwa

**GnuCash Database Compatibility:**
The PostgreSQL database must remain fully compatible with GnuCash desktop. This means:
- Cannot modify existing GnuCash tables (accounts, transactions, splits, etc.)
- Extension features (Plaid linking, audit trail, user preferences) must use separate tables
- Must respect GnuCash's fraction-based numeric storage (num/denom pairs)
- Must follow double-entry bookkeeping rules (splits sum to zero)

**Reference Document:**
- `docs/IMPLEMENTATION_PLAN.md` contains detailed implementation guidance for each phase

## Constraints

- **Database Compatibility**: Cannot modify GnuCash schema; extension tables only
- **Self-Hosted**: Must run without external services (Plaid is the exception)
- **Tech Stack**: Next.js + Prisma (migration from pg) + PostgreSQL
- **Testing**: Comprehensive coverage required (API, business logic, components)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Prisma ORM upfront | Clean foundation before building features; consistent data access patterns | — Pending |
| Separate extension tables | Maintain GnuCash desktop compatibility | — Pending |
| Plaid direct import | Simpler UX than staging queue; user can edit after import | — Pending |
| On-revisit sync trigger | Automatic freshness without aggressive background polling | — Pending |
| Local auth only | Self-hosted constraint; no external dependencies | — Pending |

---
*Last updated: 2026-01-14 after initialization*
