# Roadmap: GnuCash Web

## Overview

Transform the existing read-only GnuCash Web viewer into a full transaction management system. Starting with foundation work (Prisma migration, testing), then progressively adding transaction filtering, CRUD operations, reconciliation, account management, and budgeting capabilities—all while maintaining GnuCash desktop compatibility.

## Domain Expertise

None

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Foundation** - Prisma migration and testing infrastructure
- [ ] **Phase 2: Date Filtering** - Configurable date filtering in transaction journal
- [ ] **Phase 3: Advanced Filtering** - Account type, amount range, reconciliation filters
- [ ] **Phase 4: Transaction Details** - Transaction details modal
- [ ] **Phase 5: Transaction CRUD** - Create, edit, delete transactions
- [ ] **Phase 6: Reconciliation** - Reconciliation workflow
- [ ] **Phase 7: Account Management** - Account CRUD and hierarchy reorganization
- [ ] **Phase 8: Budgeting** - Budget system with editor and reports

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

### Phase 2: Date Filtering
**Goal**: Replace hardcoded 2026-01-01 date filter with configurable date range picker
**Depends on**: Phase 1
**Research**: Unlikely (internal UI patterns)
**Plans**: TBD

Plans:
- [ ] 02-01: Date filtering UI and API integration

### Phase 3: Advanced Filtering
**Goal**: Add transaction filtering by account type, amount range, and reconciliation status
**Depends on**: Phase 2
**Research**: Unlikely (internal UI patterns)
**Plans**: TBD

Plans:
- [ ] 03-01: Filter UI components and state management
- [ ] 03-02: API filtering parameters and query logic

### Phase 4: Transaction Details
**Goal**: Transaction details modal showing full split breakdown and metadata
**Depends on**: Phase 3
**Research**: Unlikely (internal UI patterns)
**Plans**: TBD

Plans:
- [ ] 04-01: Transaction details modal component

### Phase 5: Transaction CRUD
**Goal**: Create, edit, and delete transactions with double-entry bookkeeping validation
**Depends on**: Phase 4
**Research**: Likely (GnuCash transaction rules)
**Research topics**: GnuCash transaction and split table relationships, GUID generation, double-entry enforcement (splits sum to zero), fraction-based amount storage
**Plans**: TBD

Plans:
- [ ] 05-01: Transaction creation form and validation
- [ ] 05-02: Transaction edit functionality
- [ ] 05-03: Transaction delete with confirmation

### Phase 6: Reconciliation
**Goal**: Reconciliation workflow for marking transactions as cleared/reconciled
**Depends on**: Phase 5
**Research**: Likely (reconciliation workflow patterns)
**Research topics**: GnuCash reconciliation state machine (n/c/y states), reconciliation balance calculation, statement date handling
**Plans**: TBD

Plans:
- [ ] 06-01: Reconciliation panel and workflow

### Phase 7: Account Management
**Goal**: Account CRUD operations and hierarchy reorganization
**Depends on**: Phase 6
**Research**: Unlikely (follows Phase 5 patterns)
**Plans**: TBD

Plans:
- [ ] 07-01: Account creation and editing
- [ ] 07-02: Account hierarchy drag-drop reorganization

### Phase 8: Budgeting
**Goal**: Budget management system with spreadsheet editor and vs-actual reporting
**Depends on**: Phase 7
**Research**: Likely (GnuCash budget schema)
**Research topics**: GnuCash budgets and budget_amounts tables, budget period handling, budget recurrence patterns
**Plans**: TBD

Plans:
- [ ] 08-01: Budget list and management
- [ ] 08-02: Budget editor (spreadsheet-style)
- [ ] 08-03: Budget vs Actual view and reports

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 0/5 | Not started | - |
| 2. Date Filtering | 0/1 | Not started | - |
| 3. Advanced Filtering | 0/2 | Not started | - |
| 4. Transaction Details | 0/1 | Not started | - |
| 5. Transaction CRUD | 0/3 | Not started | - |
| 6. Reconciliation | 0/1 | Not started | - |
| 7. Account Management | 0/2 | Not started | - |
| 8. Budgeting | 0/3 | Not started | - |
