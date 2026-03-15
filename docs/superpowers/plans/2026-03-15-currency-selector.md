# Currency Selector for New Book — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual 3-character currency text input in CreateBookWizard with a searchable dropdown populated from a hardcoded ISO 4217 currency list.

**Architecture:** Add a static currency data file (`src/lib/currencies.ts`) and a reusable `CurrencySelect` component. Both the template and import flows in CreateBookWizard will use this component instead of the raw text input.

**Tech Stack:** React 19, TypeScript, Tailwind CSS

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/lib/currencies.ts` | Hardcoded ISO 4217 currency list |
| Create | `src/components/CurrencySelect.tsx` | Searchable dropdown component |
| Modify | `src/components/CreateBookWizard.tsx` | Replace both currency inputs |

---

### Task 1: Create ISO 4217 Currency Data

**Files:**
- Create: `src/lib/currencies.ts`

- [ ] **Step 1: Create the currency data file**

```typescript
// src/lib/currencies.ts
export interface Currency {
  code: string;
  name: string;
}

export const ISO_4217_CURRENCIES: Currency[] = [
  { code: 'AED', name: 'UAE Dirham' },
  { code: 'AFN', name: 'Afghani' },
  { code: 'ALL', name: 'Lek' },
  { code: 'AMD', name: 'Armenian Dram' },
  { code: 'ANG', name: 'Netherlands Antillean Guilder' },
  { code: 'AOA', name: 'Kwanza' },
  { code: 'ARS', name: 'Argentine Peso' },
  { code: 'AUD', name: 'Australian Dollar' },
  { code: 'AWG', name: 'Aruban Florin' },
  { code: 'AZN', name: 'Azerbaijan Manat' },
  { code: 'BAM', name: 'Convertible Mark' },
  { code: 'BBD', name: 'Barbados Dollar' },
  { code: 'BDT', name: 'Taka' },
  { code: 'BGN', name: 'Bulgarian Lev' },
  { code: 'BHD', name: 'Bahraini Dinar' },
  { code: 'BIF', name: 'Burundi Franc' },
  { code: 'BMD', name: 'Bermudian Dollar' },
  { code: 'BND', name: 'Brunei Dollar' },
  { code: 'BOB', name: 'Boliviano' },
  { code: 'BRL', name: 'Brazilian Real' },
  { code: 'BSD', name: 'Bahamian Dollar' },
  { code: 'BTN', name: 'Ngultrum' },
  { code: 'BWP', name: 'Pula' },
  { code: 'BYN', name: 'Belarusian Ruble' },
  { code: 'BZD', name: 'Belize Dollar' },
  { code: 'CAD', name: 'Canadian Dollar' },
  { code: 'CDF', name: 'Congolese Franc' },
  { code: 'CHF', name: 'Swiss Franc' },
  { code: 'CLP', name: 'Chilean Peso' },
  { code: 'CNY', name: 'Yuan Renminbi' },
  { code: 'COP', name: 'Colombian Peso' },
  { code: 'CRC', name: 'Costa Rican Colon' },
  { code: 'CUP', name: 'Cuban Peso' },
  { code: 'CVE', name: 'Cabo Verde Escudo' },
  { code: 'CZK', name: 'Czech Koruna' },
  { code: 'DJF', name: 'Djibouti Franc' },
  { code: 'DKK', name: 'Danish Krone' },
  { code: 'DOP', name: 'Dominican Peso' },
  { code: 'DZD', name: 'Algerian Dinar' },
  { code: 'EGP', name: 'Egyptian Pound' },
  { code: 'ERN', name: 'Nakfa' },
  { code: 'ETB', name: 'Ethiopian Birr' },
  { code: 'EUR', name: 'Euro' },
  { code: 'FJD', name: 'Fiji Dollar' },
  { code: 'FKP', name: 'Falkland Islands Pound' },
  { code: 'GBP', name: 'Pound Sterling' },
  { code: 'GEL', name: 'Lari' },
  { code: 'GHS', name: 'Ghana Cedi' },
  { code: 'GIP', name: 'Gibraltar Pound' },
  { code: 'GMD', name: 'Dalasi' },
  { code: 'GNF', name: 'Guinean Franc' },
  { code: 'GTQ', name: 'Quetzal' },
  { code: 'GYD', name: 'Guyana Dollar' },
  { code: 'HKD', name: 'Hong Kong Dollar' },
  { code: 'HNL', name: 'Lempira' },
  { code: 'HRK', name: 'Kuna' },
  { code: 'HTG', name: 'Gourde' },
  { code: 'HUF', name: 'Forint' },
  { code: 'IDR', name: 'Rupiah' },
  { code: 'ILS', name: 'New Israeli Sheqel' },
  { code: 'INR', name: 'Indian Rupee' },
  { code: 'IQD', name: 'Iraqi Dinar' },
  { code: 'IRR', name: 'Iranian Rial' },
  { code: 'ISK', name: 'Iceland Krona' },
  { code: 'JMD', name: 'Jamaican Dollar' },
  { code: 'JOD', name: 'Jordanian Dinar' },
  { code: 'JPY', name: 'Yen' },
  { code: 'KES', name: 'Kenyan Shilling' },
  { code: 'KGS', name: 'Som' },
  { code: 'KHR', name: 'Riel' },
  { code: 'KMF', name: 'Comorian Franc' },
  { code: 'KPW', name: 'North Korean Won' },
  { code: 'KRW', name: 'Won' },
  { code: 'KWD', name: 'Kuwaiti Dinar' },
  { code: 'KYD', name: 'Cayman Islands Dollar' },
  { code: 'KZT', name: 'Tenge' },
  { code: 'LAK', name: 'Lao Kip' },
  { code: 'LBP', name: 'Lebanese Pound' },
  { code: 'LKR', name: 'Sri Lanka Rupee' },
  { code: 'LRD', name: 'Liberian Dollar' },
  { code: 'LSL', name: 'Loti' },
  { code: 'LYD', name: 'Libyan Dinar' },
  { code: 'MAD', name: 'Moroccan Dirham' },
  { code: 'MDL', name: 'Moldovan Leu' },
  { code: 'MGA', name: 'Malagasy Ariary' },
  { code: 'MKD', name: 'Denar' },
  { code: 'MMK', name: 'Kyat' },
  { code: 'MNT', name: 'Tugrik' },
  { code: 'MOP', name: 'Pataca' },
  { code: 'MRU', name: 'Ouguiya' },
  { code: 'MUR', name: 'Mauritius Rupee' },
  { code: 'MVR', name: 'Rufiyaa' },
  { code: 'MWK', name: 'Malawi Kwacha' },
  { code: 'MXN', name: 'Mexican Peso' },
  { code: 'MYR', name: 'Malaysian Ringgit' },
  { code: 'MZN', name: 'Mozambique Metical' },
  { code: 'NAD', name: 'Namibia Dollar' },
  { code: 'NGN', name: 'Naira' },
  { code: 'NIO', name: 'Cordoba Oro' },
  { code: 'NOK', name: 'Norwegian Krone' },
  { code: 'NPR', name: 'Nepalese Rupee' },
  { code: 'NZD', name: 'New Zealand Dollar' },
  { code: 'OMR', name: 'Rial Omani' },
  { code: 'PAB', name: 'Balboa' },
  { code: 'PEN', name: 'Sol' },
  { code: 'PGK', name: 'Kina' },
  { code: 'PHP', name: 'Philippine Peso' },
  { code: 'PKR', name: 'Pakistan Rupee' },
  { code: 'PLN', name: 'Zloty' },
  { code: 'PYG', name: 'Guarani' },
  { code: 'QAR', name: 'Qatari Rial' },
  { code: 'RON', name: 'Romanian Leu' },
  { code: 'RSD', name: 'Serbian Dinar' },
  { code: 'RUB', name: 'Russian Ruble' },
  { code: 'RWF', name: 'Rwanda Franc' },
  { code: 'SAR', name: 'Saudi Riyal' },
  { code: 'SBD', name: 'Solomon Islands Dollar' },
  { code: 'SCR', name: 'Seychelles Rupee' },
  { code: 'SDG', name: 'Sudanese Pound' },
  { code: 'SEK', name: 'Swedish Krona' },
  { code: 'SGD', name: 'Singapore Dollar' },
  { code: 'SHP', name: 'Saint Helena Pound' },
  { code: 'SLE', name: 'Leone' },
  { code: 'SOS', name: 'Somali Shilling' },
  { code: 'SRD', name: 'Surinam Dollar' },
  { code: 'SSP', name: 'South Sudanese Pound' },
  { code: 'STN', name: 'Dobra' },
  { code: 'SVC', name: 'El Salvador Colon' },
  { code: 'SYP', name: 'Syrian Pound' },
  { code: 'SZL', name: 'Lilangeni' },
  { code: 'THB', name: 'Baht' },
  { code: 'TJS', name: 'Somoni' },
  { code: 'TMT', name: 'Turkmenistan New Manat' },
  { code: 'TND', name: 'Tunisian Dinar' },
  { code: 'TOP', name: 'Pa\'anga' },
  { code: 'TRY', name: 'Turkish Lira' },
  { code: 'TTD', name: 'Trinidad and Tobago Dollar' },
  { code: 'TWD', name: 'New Taiwan Dollar' },
  { code: 'TZS', name: 'Tanzanian Shilling' },
  { code: 'UAH', name: 'Hryvnia' },
  { code: 'UGX', name: 'Uganda Shilling' },
  { code: 'USD', name: 'US Dollar' },
  { code: 'UYU', name: 'Peso Uruguayo' },
  { code: 'UZS', name: 'Uzbekistan Sum' },
  { code: 'VES', name: 'Bolívar Soberano' },
  { code: 'VND', name: 'Dong' },
  { code: 'VUV', name: 'Vatu' },
  { code: 'WST', name: 'Tala' },
  { code: 'XAF', name: 'CFA Franc BEAC' },
  { code: 'XCD', name: 'East Caribbean Dollar' },
  { code: 'XOF', name: 'CFA Franc BCEAO' },
  { code: 'XPF', name: 'CFP Franc' },
  { code: 'YER', name: 'Yemeni Rial' },
  { code: 'ZAR', name: 'Rand' },
  { code: 'ZMW', name: 'Zambian Kwacha' },
  { code: 'ZWL', name: 'Zimbabwe Dollar' },
];

export function findCurrency(code: string): Currency | undefined {
  return ISO_4217_CURRENCIES.find(c => c.code === code.toUpperCase());
}

export function searchCurrencies(query: string): Currency[] {
  const q = query.toLowerCase();
  return ISO_4217_CURRENCIES.filter(
    c => c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/currencies.ts
git commit -m "feat: add hardcoded ISO 4217 currency list"
```

---

### Task 2: Create CurrencySelect Component

**Files:**
- Create: `src/components/CurrencySelect.tsx`

- [ ] **Step 1: Create the searchable dropdown component**

```tsx
// src/components/CurrencySelect.tsx
'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { ISO_4217_CURRENCIES, searchCurrencies, type Currency } from '@/lib/currencies';

interface CurrencySelectProps {
  value: string;
  onChange: (code: string) => void;
  className?: string;
}

export default function CurrencySelect({ value, onChange, className }: CurrencySelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = search ? searchCurrencies(search) : ISO_4217_CURRENCIES;
  const selected = ISO_4217_CURRENCIES.find(c => c.code === value);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleSelect = useCallback((currency: Currency) => {
    onChange(currency.code);
    setIsOpen(false);
    setSearch('');
  }, [onChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setIsOpen(false);
      setSearch('');
    }
  }, []);

  return (
    <div ref={containerRef} className={`relative ${className || ''}`}>
      <button
        type="button"
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen) setTimeout(() => inputRef.current?.focus(), 0);
        }}
        role="combobox"
        aria-expanded={isOpen}
        aria-label="Select currency"
        className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-md text-left text-zinc-200 hover:border-zinc-500 focus:border-blue-500 focus:outline-none flex items-center justify-between"
      >
        <span>{selected ? `${selected.code} — ${selected.name}` : value || 'Select currency...'}</span>
        <span className="text-zinc-500 ml-2">▼</span>
      </button>

      {isOpen && (
        <div className="absolute z-50 mt-1 w-full bg-zinc-800 border border-zinc-700 rounded-md shadow-lg max-h-60 overflow-hidden">
          <div className="p-2 border-b border-zinc-700">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search currencies..."
              className="w-full px-2 py-1 bg-zinc-900 border border-zinc-600 rounded text-sm text-zinc-200 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div className="overflow-y-auto max-h-48">
            {filtered.map(currency => (
              <button
                key={currency.code}
                type="button"
                onClick={() => handleSelect(currency)}
                className={`w-full px-3 py-2 text-left text-sm hover:bg-zinc-700 ${
                  currency.code === value ? 'bg-blue-600 text-white' : 'text-zinc-200'
                }`}
              >
                {currency.code} — {currency.name}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-sm text-zinc-500">No currencies found</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/CurrencySelect.tsx
git commit -m "feat: add CurrencySelect searchable dropdown component"
```

---

### Task 3: Replace Currency Inputs in CreateBookWizard

**Files:**
- Modify: `src/components/CreateBookWizard.tsx:195-202` (import flow `<input>` element)
- Modify: `src/components/CreateBookWizard.tsx:314-321` (template flow `<input>` element)

- [ ] **Step 1: Add import for CurrencySelect**

At the top of `CreateBookWizard.tsx`, add:
```typescript
import CurrencySelect from './CurrencySelect';
```

- [ ] **Step 2: Replace import flow currency input (lines 195-202)**

Find the `<input type="text" ... maxLength={3}>` element in the import flow section (lines 195-202). Replace only the `<input>` element — keep the surrounding `<div>` wrapper and `<label>`:
```tsx
<CurrencySelect value={currency} onChange={setCurrency} />
```

Note: if a template sets a currency code not in the ISO 4217 list, the button will display the raw code value as fallback (via `value || 'Select currency...'`).

- [ ] **Step 3: Replace template flow currency input (lines 314-321)**

Same replacement in the template flow section — replace only the `<input>` element, keep wrapper and label:
```tsx
<CurrencySelect value={currency} onChange={setCurrency} />
```

- [ ] **Step 4: Verify the wizard renders correctly**

Run: `npm run dev`
Navigate to the book creation wizard and test:
- Template flow: currency dropdown appears, auto-selects from template, searchable
- Import flow: currency dropdown appears, defaults to USD, searchable
- Selecting a currency updates the state correctly

- [ ] **Step 5: Commit**

```bash
git add src/components/CreateBookWizard.tsx
git commit -m "feat: replace currency text inputs with searchable dropdown in CreateBookWizard"
```
