import { useCallback } from 'react';
import { evaluateMathExpression } from '@/lib/math-eval';

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
    // Evaluate any math expression first so inputs like "123 + 256" compute
    // before tax is applied. Falls back to parseFloat for plain numeric input.
    const mathResult = evaluateMathExpression(currentAmount);
    const baseValue = mathResult !== null ? mathResult : parseFloat(currentAmount);
    if (!Number.isFinite(baseValue) || baseValue === 0) return;
    const withTax = Math.round(baseValue * (1 + taxRate) * 100) / 100;
    onAmountChange(withTax.toFixed(2));
    onMessage?.(`Tax applied: ${baseValue.toFixed(2)} + ${(taxRate * 100).toFixed(1)}% = ${withTax.toFixed(2)}`);
  }, [currentAmount, taxRate, onAmountChange, onMessage]);

  return { applyTax };
}
