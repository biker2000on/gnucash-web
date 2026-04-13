'use client';

import { PayslipLineItem, PayslipLineItemCategory } from '@/lib/types';
import { AccountSelector } from '@/components/ui/AccountSelector';

interface MappingEntry {
  normalized_label: string;
  line_item_category: string;
  account_guid: string;
}

interface PayslipLineItemTableProps {
  lineItems: PayslipLineItem[];
  employerName: string;
  mappings: MappingEntry[];
  onMappingChange: (normalized_label: string, category: string, account_guid: string) => void;
  onLineItemEdit?: (index: number, field: string, value: unknown) => void;
  editable?: boolean;
}

const CATEGORY_LABELS: Record<PayslipLineItemCategory, string> = {
  earnings: 'Earnings',
  tax: 'Tax',
  deduction: 'Deduction',
  employer_contribution: 'Employer',
  reimbursement: 'Reimbursement',
};

const CATEGORY_COLORS: Record<PayslipLineItemCategory, string> = {
  earnings: 'text-positive',
  tax: 'text-negative',
  deduction: 'text-negative',
  employer_contribution: 'text-foreground-muted',
  reimbursement: 'text-primary',
};

function formatAmount(amount: number): string {
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function CategoryBadge({ category }: { category: PayslipLineItemCategory }) {
  const colorClass = CATEGORY_COLORS[category];
  const label = CATEGORY_LABELS[category];

  return (
    <span className={`inline-flex items-center text-xs font-medium ${colorClass}`}>
      {label}
    </span>
  );
}

export function PayslipLineItemTable({
  lineItems,
  mappings,
  onMappingChange,
  onLineItemEdit,
  editable = false,
}: PayslipLineItemTableProps) {
  const unmappedCount = lineItems.filter(item => {
    if (item.category === 'employer_contribution') return false;
    const mapping = mappings.find(m => m.normalized_label === item.normalized_label);
    return !mapping || !mapping.account_guid;
  }).length;

  function getMappingAccountGuid(normalizedLabel: string): string {
    const mapping = mappings.find(m => m.normalized_label === normalizedLabel);
    return mapping?.account_guid ?? '';
  }

  function isRowUnmapped(item: PayslipLineItem): boolean {
    if (item.category === 'employer_contribution') return false;
    return !getMappingAccountGuid(item.normalized_label);
  }

  function handleAccountChange(item: PayslipLineItem, accountGuid: string) {
    onMappingChange(item.normalized_label, item.category, accountGuid);
  }

  return (
    <div className="flex flex-col gap-3">
      {unmappedCount > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-sm">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <span>
            {unmappedCount} line {unmappedCount === 1 ? 'item needs' : 'items need'} account mapping
          </span>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-foreground-muted border-b border-border">
              <th className="text-left font-medium pb-2 pr-4 w-28">Type</th>
              <th className="text-left font-medium pb-2 pr-4">Label</th>
              <th className="text-right font-medium pb-2 pr-4 w-32">Amount</th>
              <th className="text-left font-medium pb-2 w-64">Account</th>
            </tr>
          </thead>
          <tbody>
            {lineItems.map((item, index) => {
              const unmapped = isRowUnmapped(item);
              const accountGuid = getMappingAccountGuid(item.normalized_label);
              const isEmployerContrib = item.category === 'employer_contribution';

              return (
                <tr
                  key={`${item.normalized_label}-${index}`}
                  className={`border-b border-border/50 last:border-0 ${unmapped ? 'bg-yellow-500/5' : ''}`}
                >
                  {/* Type */}
                  <td className="py-2 pr-4">
                    <CategoryBadge category={item.category} />
                  </td>

                  {/* Label */}
                  <td className="py-2 pr-4">
                    <div className="flex flex-col">
                      <span className="text-foreground">{item.label}</span>
                      {item.normalized_label !== item.label && (
                        <span className="text-xs text-foreground-muted">{item.normalized_label}</span>
                      )}
                    </div>
                  </td>

                  {/* Amount */}
                  <td className="py-2 pr-4 text-right">
                    {editable && onLineItemEdit ? (
                      <input
                        type="number"
                        step="0.01"
                        defaultValue={item.amount}
                        onChange={e => onLineItemEdit(index, 'amount', parseFloat(e.target.value))}
                        className="w-full text-right font-mono tabular-nums text-foreground bg-input-bg border border-border rounded px-2 py-1 focus:ring-2 focus:ring-primary/40 focus:outline-none text-sm"
                      />
                    ) : (
                      <span className="font-mono tabular-nums text-foreground">
                        ${formatAmount(item.amount)}
                      </span>
                    )}
                  </td>

                  {/* Account */}
                  <td className="py-2">
                    {isEmployerContrib ? (
                      <span className="text-xs text-foreground-muted italic">Informational only</span>
                    ) : (
                      <AccountSelector
                        value={accountGuid}
                        onChange={(guid) => handleAccountChange(item, guid)}
                        compact
                        hasError={unmapped}
                        placeholder="Select account..."
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
