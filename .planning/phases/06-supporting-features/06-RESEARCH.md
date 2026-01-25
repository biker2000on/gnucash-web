# Phase 06: Supporting Features - Research

**Researched:** 2026-01-24
**Domain:** Investments, Multi-Currency, Authentication, Audit Trail
**Confidence:** HIGH

## Summary

This phase implements supporting features that enhance the core application: investment account support with commodity valuation, advanced multi-currency handling, local authentication, and audit trail for data integrity. These features leverage existing GnuCash tables (commodities, prices) and add extension tables for authentication and audit.

**Primary recommendation:** Use GnuCash's existing commodity/price tables for investments, implement currency chain traversal for multi-currency, and create separate extension tables for auth and audit to maintain GnuCash desktop compatibility.

## GnuCash Commodity Schema

### commodities Table
```sql
CREATE TABLE commodities (
  guid CHAR(32) PRIMARY KEY,
  namespace TEXT,       -- 'CURRENCY', 'AMEX', 'NASDAQ', etc.
  mnemonic TEXT,        -- 'USD', 'AAPL', 'BTC'
  fullname TEXT,
  cusip TEXT,           -- CUSIP/ISIN for stocks
  fraction INT,         -- Smallest unit (100 for USD, 10000 for stocks)
  quote_flag INT,       -- Enable price quotes
  quote_source TEXT,    -- Source for quotes
  quote_tz TEXT
);
```

### prices Table
```sql
CREATE TABLE prices (
  guid CHAR(32) PRIMARY KEY,
  commodity_guid CHAR(32),
  currency_guid CHAR(32),
  date DATE,
  source TEXT,          -- 'user:price', 'Finance::Quote'
  type TEXT,            -- 'last', 'nav', 'unknown'
  value_num BIGINT,
  value_denom BIGINT
);
```

## Extension Tables (for Auth & Audit)

```sql
-- User authentication (extension table)
CREATE TABLE gnucash_web_users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  last_login TIMESTAMP
);

-- Audit trail (extension table)
CREATE TABLE gnucash_web_audit (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES gnucash_web_users(id),
  action TEXT,          -- 'CREATE', 'UPDATE', 'DELETE'
  entity_type TEXT,     -- 'transaction', 'account', etc.
  entity_guid CHAR(32),
  old_values JSONB,
  new_values JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
```

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `bcrypt` | ^5.x | Password hashing | Industry standard, secure |
| `jose` | ^5.x | JWT tokens | Modern, standards-compliant JWT |
| `iron-session` | ^8.x | Session management | Next.js native, encrypted cookies |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `zod` | ^3.x | Validation | Auth form validation |

**Installation:**
```bash
npm install bcrypt jose iron-session
npm install -D @types/bcrypt
```

## Architecture Patterns

### Pattern 1: Investment Valuation
```typescript
const getInvestmentValue = async (accountGuid: string, asOfDate: Date) => {
  // Get shares held (quantity)
  const splits = await prisma.split.findMany({
    where: {
      account_guid: accountGuid,
      transaction: { post_date: { lte: asOfDate } }
    }
  });

  const shares = splits.reduce((sum, s) =>
    sum + Number(s.quantity_num) / Number(s.quantity_denom), 0
  );

  // Get latest price
  const account = await prisma.account.findUnique({
    where: { guid: accountGuid },
    include: { commodity: true }
  });

  const price = await prisma.price.findFirst({
    where: {
      commodity_guid: account.commodity_guid,
      date: { lte: asOfDate }
    },
    orderBy: { date: 'desc' }
  });

  const priceValue = price
    ? Number(price.value_num) / Number(price.value_denom)
    : 0;

  return shares * priceValue;
};
```

### Pattern 2: Currency Conversion Chain
```typescript
const convertCurrency = async (
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  date: Date
) => {
  if (fromCurrency === toCurrency) return amount;

  // Try direct conversion
  const directPrice = await findPrice(fromCurrency, toCurrency, date);
  if (directPrice) {
    return amount * directPrice;
  }

  // Try via base currency (USD)
  const toBase = await findPrice(fromCurrency, 'USD', date);
  const fromBase = await findPrice('USD', toCurrency, date);

  if (toBase && fromBase) {
    return amount * toBase * fromBase;
  }

  throw new Error(`No exchange rate found for ${fromCurrency} to ${toCurrency}`);
};
```

### Pattern 3: Session-Based Auth (iron-session)
```typescript
// lib/session.ts
import { getIronSession } from 'iron-session';

export const sessionOptions = {
  password: process.env.SESSION_SECRET!,
  cookieName: 'gnucash-web-session',
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
  },
};

export interface SessionData {
  userId?: number;
  username?: string;
  isLoggedIn: boolean;
}

// API route
export async function POST(req: Request) {
  const session = await getIronSession<SessionData>(req, sessionOptions);
  // ... validate credentials
  session.userId = user.id;
  session.username = user.username;
  session.isLoggedIn = true;
  await session.save();
}
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Password hashing | MD5/SHA | bcrypt | Purpose-built, work factor, salt |
| Sessions | Custom cookies | iron-session | Encrypted, Next.js native |
| JWT | Manual signing | jose | Standards-compliant, secure defaults |

## Common Pitfalls

### Pitfall 1: Price Date Gaps
**What goes wrong:** No price for specific date.
**Why it happens:** Prices only stored when manually entered or fetched.
**How to avoid:** Use most recent price before target date.

### Pitfall 2: Circular Currency Conversion
**What goes wrong:** Infinite loop in conversion.
**Why it happens:** Price table has bidirectional entries.
**How to avoid:** Track visited currencies in conversion chain.

### Pitfall 3: Session Secret Rotation
**What goes wrong:** All users logged out.
**Why it happens:** Changing SESSION_SECRET invalidates existing sessions.
**How to avoid:** Support multiple secrets during rotation period.

## Sources

### Primary (HIGH confidence)
- [GnuCash Wiki: SQL](https://wiki.gnucash.org/wiki/SQL) - Commodity/Price tables
- [iron-session Documentation](https://github.com/vvo/iron-session) - Session management
- [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) - Security best practices

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH
- Architecture: HIGH
- Pitfalls: MEDIUM (currency conversion edge cases)

**Research date:** 2026-01-24
**Valid until:** 2026-02-24
