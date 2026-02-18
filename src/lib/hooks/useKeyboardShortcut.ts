import { useEffect, useRef } from 'react'
import { useKeyboardShortcuts, type ShortcutScope } from '@/contexts/KeyboardShortcutContext'

export function useKeyboardShortcut(
  id: string,
  key: string,
  description: string,
  handler: () => void,
  scope: ShortcutScope = 'global',
  enabled: boolean = true
) {
  const { register } = useKeyboardShortcuts()
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (!enabled) return

    const cleanup = register(id, key, description, () => handlerRef.current(), scope, enabled)
    return cleanup
  }, [id, key, description, scope, enabled, register])
}
