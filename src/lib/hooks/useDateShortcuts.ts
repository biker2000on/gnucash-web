import { useCallback } from 'react';
import { toLocalDateString } from '@/lib/datePresets';

export function useDateShortcuts(
  currentDate: string,
  onDateChange: (newDate: string) => void
) {
  const handleDateKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      const current = new Date(currentDate + 'T12:00:00');
      current.setDate(current.getDate() + 1);
      onDateChange(toLocalDateString(current));
    } else if (e.key === '-') {
      e.preventDefault();
      const current = new Date(currentDate + 'T12:00:00');
      current.setDate(current.getDate() - 1);
      onDateChange(toLocalDateString(current));
    } else if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      onDateChange(toLocalDateString(new Date()));
    }
  }, [currentDate, onDateChange]);

  return { handleDateKeyDown };
}
