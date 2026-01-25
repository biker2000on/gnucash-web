# Phase 05: Reporting System - Research

**Researched:** 2026-01-24
**Domain:** Financial Statements, Chart Visualizations, Export Formats
**Confidence:** HIGH

## Summary

This phase implements comprehensive financial reporting including core statements (Balance Sheet, Income Statement/P&L, Cash Flow), chart visualizations, and export capabilities. The focus is on leveraging GnuCash's account type structure to automatically categorize data into standard financial report formats.

**Primary recommendation:** Use a report framework with pluggable report types, recharts for visualizations, and server-side PDF generation for exports.

## Account Type Mapping for Reports

| GnuCash Type | Report Section | Sign |
|--------------|----------------|------|
| ASSET | Balance Sheet: Assets | Positive |
| LIABILITY | Balance Sheet: Liabilities | Negative |
| EQUITY | Balance Sheet: Equity | Negative |
| INCOME | Income Statement: Revenue | Negative (credit) |
| EXPENSE | Income Statement: Expenses | Positive (debit) |

Note: GnuCash stores debits as positive, credits as negative. For reporting, we display income as positive and expenses as positive (absolute value).

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `recharts` | ^2.x | Charts | React-native, responsive, accessible |
| `@react-pdf/renderer` | ^4.x | PDF Generation | React-based PDF creation |
| `xlsx` | ^0.18.x | Excel Export | Full Excel format support |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `papaparse` | ^5.x | CSV | CSV export parsing |
| `date-fns` | ^4.x | Date ranges | Period calculations |

**Installation:**
```bash
npm install recharts @react-pdf/renderer xlsx papaparse
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── app/
│   ├── (main)/reports/
│   │   ├── page.tsx           # Report selector
│   │   ├── balance-sheet/page.tsx
│   │   ├── income-statement/page.tsx
│   │   └── cash-flow/page.tsx
│   └── api/reports/
│       ├── balance-sheet/route.ts
│       ├── income-statement/route.ts
│       └── cash-flow/route.ts
├── components/reports/
│   ├── ReportViewer.tsx       # Common report wrapper
│   ├── ReportFilters.tsx      # Date range, comparison
│   ├── BalanceSheet.tsx
│   ├── IncomeStatement.tsx
│   └── CashFlow.tsx
└── lib/reports/
    ├── generators/            # Report data generators
    └── exporters/             # PDF, Excel, CSV exports
```

### Pattern 1: Balance Sheet Calculation
```typescript
const getBalanceSheet = async (asOfDate: Date) => {
  const accounts = await prisma.$queryRaw`
    SELECT
      a.guid, a.name, a.account_type,
      COALESCE(SUM(s.value_num::decimal / s.value_denom::decimal), 0) as balance
    FROM accounts a
    LEFT JOIN splits s ON s.account_guid = a.guid
    LEFT JOIN transactions t ON t.guid = s.tx_guid
    WHERE t.post_date <= ${asOfDate} OR t.guid IS NULL
    GROUP BY a.guid, a.name, a.account_type
    ORDER BY a.account_type, a.name
  `;

  const assets = accounts.filter(a => a.account_type === 'ASSET');
  const liabilities = accounts.filter(a => a.account_type === 'LIABILITY');
  const equity = accounts.filter(a => a.account_type === 'EQUITY');

  return {
    assets: { accounts: assets, total: sum(assets, 'balance') },
    liabilities: { accounts: liabilities, total: Math.abs(sum(liabilities, 'balance')) },
    equity: { accounts: equity, total: Math.abs(sum(equity, 'balance')) },
  };
};
```

### Pattern 2: Income Statement
```typescript
const getIncomeStatement = async (startDate: Date, endDate: Date) => {
  const accounts = await prisma.$queryRaw`
    SELECT
      a.guid, a.name, a.account_type,
      COALESCE(SUM(s.value_num::decimal / s.value_denom::decimal), 0) as amount
    FROM accounts a
    LEFT JOIN splits s ON s.account_guid = a.guid
    LEFT JOIN transactions t ON t.guid = s.tx_guid
    WHERE t.post_date BETWEEN ${startDate} AND ${endDate}
    GROUP BY a.guid, a.name, a.account_type
    HAVING a.account_type IN ('INCOME', 'EXPENSE')
  `;

  const income = accounts.filter(a => a.account_type === 'INCOME');
  const expenses = accounts.filter(a => a.account_type === 'EXPENSE');

  return {
    revenue: Math.abs(sum(income, 'amount')),
    expenses: sum(expenses, 'amount'),
    netIncome: Math.abs(sum(income, 'amount')) - sum(expenses, 'amount'),
  };
};
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PDF generation | html-to-pdf | @react-pdf/renderer | Native React, better styling control |
| Charts | Canvas API | recharts | Responsive, accessible, animations |
| Excel | Manual XML | xlsx | Full Excel feature support |

## Common Pitfalls

### Pitfall 1: Sign Confusion
**What goes wrong:** Income shows as negative.
**Why it happens:** GnuCash stores credits as negative.
**How to avoid:** Apply Math.abs() for income and liabilities in display.

### Pitfall 2: Missing Opening Balances
**What goes wrong:** P&L shows wrong retained earnings.
**Why it happens:** Not including previous period income/expense in equity.
**How to avoid:** Calculate retained earnings as sum of all income/expense before period.

### Pitfall 3: Currency Mixing
**What goes wrong:** Report totals are incorrect.
**Why it happens:** Summing amounts in different currencies.
**How to avoid:** Filter by commodity or convert to base currency.

## Code Examples

### React PDF Report
```typescript
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

const BalanceSheetPDF = ({ data, asOfDate }) => (
  <Document>
    <Page style={styles.page}>
      <Text style={styles.title}>Balance Sheet</Text>
      <Text style={styles.date}>As of {formatDate(asOfDate)}</Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Assets</Text>
        {data.assets.accounts.map(account => (
          <View key={account.guid} style={styles.row}>
            <Text>{account.name}</Text>
            <Text>{formatCurrency(account.balance)}</Text>
          </View>
        ))}
        <Text style={styles.total}>Total Assets: {formatCurrency(data.assets.total)}</Text>
      </View>
    </Page>
  </Document>
);
```

## Sources

### Primary (HIGH confidence)
- [GnuCash Wiki: Reports](https://wiki.gnucash.org/wiki/Reports) - Report concepts
- [react-pdf Documentation](https://react-pdf.org/) - PDF generation

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH
- Architecture: HIGH
- Pitfalls: HIGH

**Research date:** 2026-01-24
**Valid until:** 2026-02-24
