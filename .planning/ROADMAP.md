# Roadmap: GnuCash Web

## Overview

Transform the existing read-only GnuCash Web viewer into a full transaction management system. Starting with foundation work (Prisma migration, testing), then progressively adding transaction management, account organization, budgeting, reporting, and automated bank imports—all while maintaining GnuCash desktop compatibility.

## Domain Expertise

None

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Foundation** - Prisma migration and testing infrastructure
- [ ] **Phase 2: Enhanced Transaction Journal** - Advanced filtering, CRUD operations, and reconciliation
- [ ] **Phase 3: Enhanced Account Hierarchy** - Account CRUD, reorganization, and summary aggregations
- [ ] **Phase 4: Budgeting System** - Budget editor, vs-actual views, and reports
- [ ] **Phase 5: Reporting System** - Financial statements (P&L, Balance Sheet) and chart visualizations
- [ ] **Phase 6: Supporting Features** - Investments, multi-currency support, and authentication
- [ ] **Phase 7: Plaid Integration** - Automated transaction imports and bank linking

## Phase Details

### Phase 1: Foundation
**Goal**: Migrate from direct pg queries to Prisma ORM and establish comprehensive testing infrastructure
**Depends on**: Nothing (first phase)
**Research**: Completed (Prisma migration patterns, Next.js App Router testing)
**Research topics**: Prisma introspection for existing PostgreSQL schema, GnuCash fraction-based numeric handling in Prisma, testing patterns for Next.js 16 App Router API routes
**Plans**: 5 plans

Plans:
- [ ] 01-01-PLAN.md — Prisma Core Setup
- [ ] 01-02-PLAN.md — Testing Infrastructure
- [ ] 01-03-PLAN.md — TDD: Prisma Extension Logic
- [ ] 01-04-PLAN.md — API Migration - Core Routes
- [ ] 01-05-PLAN.md — API Migration - Remaining Routes

### Phase 2: Enhanced Transaction Journal
**Goal**: Advanced filtering and full CRUD operations with double-entry validation and reconciliation
**Depends on**: Phase 1
**Research**: Completed (GnuCash transaction rules)
**Research topics**: GnuCash transaction and split table relationships, GUID generation, double-entry enforcement, fraction-based amount storage, reconciliation states (n/c/y)
**Plans**: 4 plans

Plans:
- [ ] 02-01-PLAN.md — Advanced Filtering & Details UI
- [ ] 02-02-PLAN.md — CRUD Infrastructure & Backend
- [ ] 02-03-PLAN.md — Transaction Form & Editor
- [ ] 02-04-PLAN.md — Reconciliation Workflow

### Phase 3: Enhanced Account Hierarchy
**Goal**: Account CRUD operations, hierarchy reorganization, and summary aggregations
**Depends on**: Phase 2
**Research**: Completed (DnD patterns, account constraints)
**Research topics**: @dnd-kit for drag-drop, account type constraints, circular reference prevention
**Plans**: 3 plans

Plans:
- [ ] 03-01-PLAN.md — Account CRUD Operations
- [ ] 03-02-PLAN.md — Drag-Drop Hierarchy Reorganization
- [ ] 03-03-PLAN.md — Account Type Summary Cards

### Phase 4: Budgeting System
**Goal**: Budget management system with spreadsheet editor and vs-actual reporting
**Depends on**: Phase 3
**Research**: Completed (GnuCash budget schema)
**Research topics**: GnuCash budgets and budget_amounts tables, budget period handling, budget recurrence patterns
**Plans**: 3 plans

Plans:
- [ ] 04-01-PLAN.md — Budget List and Management
- [ ] 04-02-PLAN.md — Spreadsheet-Style Budget Editor
- [ ] 04-03-PLAN.md — Budget vs Actual Comparison and Reports

### Phase 5: Reporting System
**Goal**: Comprehensive financial reporting framework and visualizations
**Depends on**: Phase 1
**Research**: Completed (Financial report logic)
**Research topics**: Balance sheet and P&L calculation logic for GnuCash schema, PDF/CSV export libraries for Next.js
**Plans**: 3 plans

Plans:
- [ ] 05-01-PLAN.md — Report Framework and Base UI
- [ ] 05-02-PLAN.md — Core Financial Statements (Balance Sheet, P&L, Cash Flow)
- [ ] 05-03-PLAN.md — Chart Visualizations and Export (PDF, Excel, CSV)

### Phase 6: Supporting Features
**Goal**: Investments, multi-currency support, authentication, and data integrity
**Depends on**: Phase 1
**Research**: Completed (Investment valuation & Multi-currency)
**Research topics**: GnuCash commodity/price tables, currency chain traversal, local authentication patterns for self-hosting
**Plans**: 3 plans

Plans:
- [ ] 06-01-PLAN.md — Investment Account Support (Commodity Valuation)
- [ ] 06-02-PLAN.md — Advanced Multi-Currency Support
- [ ] 06-03-PLAN.md — Local User Authentication and Audit Trail

### Phase 7: Plaid Integration
**Goal**: Automated bank transaction imports via Plaid
**Depends on**: Phase 2 (for CRUD) & Phase 6 (for Auth)
**Research**: Very Likely (Plaid API & GnuCash extension schema)
**Research topics**: Plaid Link flow in Next.js, extension tables for bank linking, sync scheduling, automatic import logic
**Plans**: 3 plans

Plans:
- [ ] 07-01: Plaid account linking (extension tables)
- [ ] 07-02: Transaction import and sync logic
- [ ] 07-03: Sync scheduling and on-revisit triggers

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 0/5 | Not started | - |
| 2. Enhanced Journal | 0/4 | Not started | - |
| 3. Enhanced Hierarchy | 0/3 | Not started | - |
| 4. Budgeting | 0/3 | Not started | - |
| 5. Reporting | 0/3 | Not started | - |
| 6. Supporting Features | 0/3 | Not started | - |
| 7. Plaid Integration | 0/3 | Not started | - |
