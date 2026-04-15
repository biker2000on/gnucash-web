import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTaxShortcut } from '@/lib/hooks/useTaxShortcut';

describe('useTaxShortcut', () => {
  it('applies tax to a plain number', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useTaxShortcut('100', 0.07, onChange));
    act(() => result.current.applyTax());
    expect(onChange).toHaveBeenCalledWith('107.00');
  });

  it('evaluates a math expression before applying tax ("123 + 256t")', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useTaxShortcut('123 + 256', 0.07, onChange));
    act(() => result.current.applyTax());
    // (123 + 256) * 1.07 = 405.53
    expect(onChange).toHaveBeenCalledWith('405.53');
  });

  it('noops when amount is zero', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useTaxShortcut('0', 0.07, onChange));
    act(() => result.current.applyTax());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports an error via onMessage when tax rate is 0', () => {
    const onChange = vi.fn();
    const onMessage = vi.fn();
    const { result } = renderHook(() => useTaxShortcut('100', 0, onChange, onMessage));
    act(() => result.current.applyTax());
    expect(onChange).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(expect.stringMatching(/no tax rate/i));
  });

  it('handles expressions with multiplication', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useTaxShortcut('5 * 10', 0.05, onChange));
    act(() => result.current.applyTax());
    // 50 * 1.05 = 52.50
    expect(onChange).toHaveBeenCalledWith('52.50');
  });
});
