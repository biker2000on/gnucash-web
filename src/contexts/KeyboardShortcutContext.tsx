'use client'

import { createContext, useContext, useCallback, useState, useEffect, ReactNode } from 'react'

type ShortcutScope = 'global' | 'transaction-form' | 'date-field' | 'amount-field'

interface ShortcutRegistration {
  id: string
  key: string
  description: string
  handler: () => void
  scope: ShortcutScope
  enabled: boolean
}

interface KeyboardShortcutContextType {
  register: (
    id: string,
    key: string,
    description: string,
    handler: () => void,
    scope?: ShortcutScope,
    enabled?: boolean
  ) => () => void
  unregister: (id: string) => void
  shortcuts: Map<string, ShortcutRegistration>
  isHelpOpen: boolean
  setHelpOpen: (open: boolean) => void
}

const KeyboardShortcutContext = createContext<KeyboardShortcutContextType | undefined>(undefined)

function matchShortcutKey(event: KeyboardEvent, key: string): boolean {
  // Normalize modifier keys (Ctrl on Windows, Meta on Mac)
  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)
  const primaryModifier = isMac ? event.metaKey : event.ctrlKey

  // Handle special keys
  if (key === 'Escape') {
    return event.key === 'Escape'
  }

  if (key === '?') {
    return event.key === '?' && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
  }

  // Handle Ctrl+Enter and Ctrl+Shift+Enter
  if (key === 'Ctrl+Enter') {
    return primaryModifier && event.key === 'Enter' && !event.shiftKey
  }

  if (key === 'Ctrl+Shift+Enter') {
    return primaryModifier && event.key === 'Enter' && event.shiftKey
  }

  // Handle plain single keys
  return event.key === key && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
}

function isInInputField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false

  const tagName = target.tagName.toLowerCase()
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
    return true
  }

  if (target.contentEditable === 'true') {
    return true
  }

  return false
}

export function KeyboardShortcutProvider({ children }: { children: ReactNode }) {
  const [shortcuts, setShortcuts] = useState<Map<string, ShortcutRegistration>>(new Map())
  const [isHelpOpen, setHelpOpen] = useState(false)
  const [chordPrefix, setChordPrefix] = useState<string | null>(null)
  const [chordTimer, setChordTimer] = useState<NodeJS.Timeout | null>(null)

  const register = useCallback(
    (
      id: string,
      key: string,
      description: string,
      handler: () => void,
      scope: ShortcutScope = 'global',
      enabled: boolean = true
    ): (() => void) => {
      setShortcuts((prev) => {
        const next = new Map(prev)
        next.set(id, { id, key, description, handler, scope, enabled })
        return next
      })

      return () => {
        setShortcuts((prev) => {
          const next = new Map(prev)
          next.delete(id)
          return next
        })
      }
    },
    []
  )

  const unregister = useCallback((id: string) => {
    setShortcuts((prev) => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if we're in an input field
      const inInputField = isInInputField(event.target)

      // If we're in an input field, only handle scoped shortcuts (not global)
      // Note: date-field and amount-field shortcuts are handled by their own onKeyDown handlers
      // We only handle global and transaction-form shortcuts here
      if (inInputField) {
        // Allow transaction-form scoped shortcuts
        for (const shortcut of shortcuts.values()) {
          if (
            shortcut.scope === 'transaction-form' &&
            shortcut.enabled &&
            matchShortcutKey(event, shortcut.key)
          ) {
            event.preventDefault()
            shortcut.handler()
            return
          }
        }
        return
      }

      // Handle chord shortcuts (g d, g a, etc.)
      if (chordPrefix) {
        // We're waiting for the second key in a chord
        const chordKey = `${chordPrefix} ${event.key}`

        // Look for matching chord shortcut
        for (const shortcut of shortcuts.values()) {
          if (
            shortcut.scope === 'global' &&
            shortcut.enabled &&
            shortcut.key === chordKey
          ) {
            event.preventDefault()
            shortcut.handler()
            setChordPrefix(null)
            if (chordTimer) {
              clearTimeout(chordTimer)
              setChordTimer(null)
            }
            return
          }
        }

        // No match - clear chord state
        setChordPrefix(null)
        if (chordTimer) {
          clearTimeout(chordTimer)
          setChordTimer(null)
        }
        return
      }

      // Check if this is the start of a chord (g key)
      if (event.key === 'g' && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
        // Check if any chord shortcuts are registered
        const hasChordShortcuts = Array.from(shortcuts.values()).some(
          (s) => s.scope === 'global' && s.enabled && s.key.startsWith('g ')
        )

        if (hasChordShortcuts) {
          event.preventDefault()
          setChordPrefix('g')

          // Set 500ms timeout for chord completion
          const timer = setTimeout(() => {
            setChordPrefix(null)
            setChordTimer(null)
          }, 500)
          setChordTimer(timer)
          return
        }
      }

      // Handle regular global shortcuts
      for (const shortcut of shortcuts.values()) {
        if (
          shortcut.scope === 'global' &&
          shortcut.enabled &&
          matchShortcutKey(event, shortcut.key)
        ) {
          event.preventDefault()
          shortcut.handler()
          return
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      if (chordTimer) {
        clearTimeout(chordTimer)
      }
    }
  }, [shortcuts, chordPrefix, chordTimer])

  return (
    <KeyboardShortcutContext.Provider
      value={{ register, unregister, shortcuts, isHelpOpen, setHelpOpen }}
    >
      {children}
    </KeyboardShortcutContext.Provider>
  )
}

export function useKeyboardShortcuts() {
  const context = useContext(KeyboardShortcutContext)
  if (!context) {
    throw new Error('useKeyboardShortcuts must be used within KeyboardShortcutProvider')
  }
  return context
}
