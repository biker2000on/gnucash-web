import { useCallback } from 'react';

export function useDateShortcuts(
  currentDate: string,
  onDateChange: (newDate: string) => void
) {
  const handleDateKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      const current = new Date(currentDate + 'T12:00:00');
      current.setDate(current.getDate() + 1);
      onDateChange(current.toISOString().split('T')[0]);
    } else if (e.key === '-') {
      e.preventDefault();
      const current = new Date(currentDate + 'T12:00:00');
      current.setDate(current.getDate() - 1);
      onDateChange(current.toISOString().split('T')[0]);
    } else if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      onDateChange(new Date().toISOString().split('T')[0]);
    }
  }, [currentDate, onDateChange]);

  return { handleDateKeyDown };
}
