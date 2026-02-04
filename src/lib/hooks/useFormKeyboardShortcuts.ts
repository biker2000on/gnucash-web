import { useEffect, RefObject } from 'react';

export function useFormKeyboardShortcuts(
  formRef: RefObject<HTMLFormElement | HTMLDivElement | null>,
  onSubmit: () => void,
  options?: {
    validate?: () => boolean;
    enabled?: boolean;
  }
) {
  useEffect(() => {
    if (options?.enabled === false) return;

    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!options?.validate || options.validate()) {
          onSubmit();
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSubmit, options?.validate, options?.enabled]);
}
