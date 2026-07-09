'use client'

import { useKeyboardShortcuts } from '@/contexts/KeyboardShortcutContext'
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut'
import { Modal } from '@/components/ui/Modal'

const scopeLabels: Record<string, string> = {
  page: 'This Page',
  global: 'Global',
  'transaction-form': 'Transaction Form',
  'date-field': 'Date Field',
  'amount-field': 'Amount Field',
}

// Page-specific shortcuts first so what's relevant right now is at the top.
const scopeOrder = ['page', 'global', 'transaction-form', 'date-field', 'amount-field']

/** Render a key string as one or more <kbd> chips (chords split on spaces). */
function KeyChips({ keyStr }: { keyStr: string }) {
  const parts = keyStr.split(' ')
  return (
    <span className="flex items-center gap-1 shrink-0">
      {parts.map((part, i) => (
        <kbd
          key={i}
          className="px-1.5 py-0.5 text-[11px] leading-none font-mono tabular-nums bg-background-secondary border border-border rounded text-foreground-secondary"
        >
          {part}
        </kbd>
      ))}
    </span>
  )
}

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

  // Group shortcuts by scope, de-duplicating by key+description (the same
  // logical shortcut can be registered by more than one mounted component).
  const shortcutsByScope = new Map<string, Array<{ key: string; description: string }>>()
  shortcuts.forEach((shortcut) => {
    if (!shortcutsByScope.has(shortcut.scope)) shortcutsByScope.set(shortcut.scope, [])
    const list = shortcutsByScope.get(shortcut.scope)!
    if (!list.some((s) => s.key === shortcut.key && s.description === shortcut.description)) {
      list.push({ key: shortcut.key, description: shortcut.description })
    }
  })
  shortcutsByScope.forEach((list) => list.sort((a, b) => a.description.localeCompare(b.description)))

  return (
    <Modal
      isOpen={isHelpOpen}
      onClose={() => setHelpOpen(false)}
      title="Keyboard Shortcuts"
      size="lg"
    >
      <div className="p-5 space-y-5">
        {scopeOrder.map((scope) => {
          const scopeShortcuts = shortcutsByScope.get(scope)
          if (!scopeShortcuts || scopeShortcuts.length === 0) return null

          return (
            <section key={scope}>
              <h3 className="text-xs font-semibold text-foreground-secondary uppercase tracking-wider mb-2">
                {scopeLabels[scope] ?? scope}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-x-6 gap-y-0.5">
                {scopeShortcuts.map(({ key, description }) => (
                  <div
                    key={`${scope}-${key}-${description}`}
                    className="flex items-center justify-between gap-3 py-1 border-b border-border/40"
                  >
                    <span className="text-[13px] text-foreground truncate">{description}</span>
                    <KeyChips keyStr={key} />
                  </div>
                ))}
              </div>
            </section>
          )
        })}
        <p className="text-xs text-foreground-muted pt-1">
          Press <kbd className="px-1 py-0.5 text-[11px] font-mono bg-background-secondary border border-border rounded">?</kbd> anytime to open this list.
          Chord shortcuts like <span className="font-mono">g d</span> are two keys pressed in sequence.
        </p>
      </div>
    </Modal>
  )
}
