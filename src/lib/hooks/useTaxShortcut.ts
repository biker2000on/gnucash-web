import { useCallback } from 'react';

export function useTaxShortcut(
  currentAmount: string,
  taxRate: number,
  onAmountChange: (newAmount: string) => void,
  onMessage?: (msg: string) => void
) {
  const applyTax = useCallback(() => {
    if (taxRate <= 0) {
      onMessage?.('No tax rate configured. Set it in Settings.');
      return;
    }
    const currentValue = parseFloat(currentAmount);
    if (isNaN(currentValue) || currentValue === 0) return;
    const withTax = Math.round(currentValue * (1 + taxRate) * 100) / 100;
    onAmountChange(withTax.toFixed(2));
    onMessage?.(`Tax applied: ${currentValue.toFixed(2)} + ${(taxRate * 100).toFixed(1)}% = ${withTax.toFixed(2)}`);
  }, [currentAmount, taxRate, onAmountChange, onMessage]);

  return { applyTax };
}
