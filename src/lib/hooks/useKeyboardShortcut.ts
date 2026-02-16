import { useEffect } from 'react'
import { useKeyboardShortcuts } from '@/contexts/KeyboardShortcutContext'

type ShortcutScope = 'global' | 'transaction-form' | 'date-field' | 'amount-field'

export function useKeyboardShortcut(
  id: string,
  key: string,
  description: string,
  handler: () => void,
  scope: ShortcutScope = 'global',
  enabled: boolean = true
) {
  const { register } = useKeyboardShortcuts()

  useEffect(() => {
    if (!enabled) return

    const cleanup = register(id, key, description, handler, scope, enabled)
    return cleanup
  }, [id, key, description, handler, scope, enabled, register])
}
