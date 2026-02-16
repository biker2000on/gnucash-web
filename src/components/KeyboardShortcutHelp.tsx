'use client'

import { useKeyboardShortcuts } from '@/contexts/KeyboardShortcutContext'
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut'
import { Modal } from '@/components/ui/Modal'
import { useEffect } from 'react'

const scopeLabels: Record<string, string> = {
  global: 'Global',
  'transaction-form': 'Transaction Form',
  'date-field': 'Date Field',
  'amount-field': 'Amount Field',
}

const scopeOrder = ['global', 'transaction-form', 'date-field', 'amount-field']

export function KeyboardShortcutHelp() {
  const { shortcuts, isHelpOpen, setHelpOpen } = useKeyboardShortcuts()

  // Register the ? key to open help
  useKeyboardShortcut(
    'help-modal',
    '?',
    'Show keyboard shortcuts',
    () => setHelpOpen(true),
    'global',
    true
  )

  // Group shortcuts by scope
  const shortcutsByScope = new Map<string, Array<{ key: string; description: string }>>()

  shortcuts.forEach((shortcut) => {
    if (!shortcutsByScope.has(shortcut.scope)) {
      shortcutsByScope.set(shortcut.scope, [])
    }
    shortcutsByScope.get(shortcut.scope)!.push({
      key: shortcut.key,
      description: shortcut.description,
    })
  })

  // Sort shortcuts within each scope by key
  shortcutsByScope.forEach((shortcuts) => {
    shortcuts.sort((a, b) => a.key.localeCompare(b.key))
  })

  return (
    <Modal
      isOpen={isHelpOpen}
      onClose={() => setHelpOpen(false)}
      title="Keyboard Shortcuts"
      size="lg"
    >
      <div className="p-6">
        <div className="space-y-6">
          {scopeOrder.map((scope) => {
            const scopeShortcuts = shortcutsByScope.get(scope)
            if (!scopeShortcuts || scopeShortcuts.length === 0) return null

            return (
              <div key={scope}>
                <h3 className="text-sm font-semibold text-foreground-secondary uppercase tracking-wider mb-3">
                  {scopeLabels[scope]}
                </h3>
                <div className="space-y-2">
                  {scopeShortcuts.map(({ key, description }) => (
                    <div
                      key={`${scope}-${key}`}
                      className="flex items-center justify-between py-2 px-3 rounded-lg bg-surface hover:bg-surface-hover transition-colors"
                    >
                      <span className="text-sm text-foreground">{description}</span>
                      <kbd className="px-2 py-1 text-xs font-mono bg-background-secondary border border-border rounded shadow-sm text-foreground-secondary">
                        {key}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}
