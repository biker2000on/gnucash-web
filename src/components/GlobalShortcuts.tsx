'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut'
import { QuickAccountSwitcher } from './QuickAccountSwitcher'
import { QuickBookSwitcher } from './QuickBookSwitcher'
import { CommandPalette } from './CommandPalette'

export function GlobalShortcuts() {
  const router = useRouter()
  const [accountSwitcherOpen, setAccountSwitcherOpen] = useState(false)
  const [bookSwitcherOpen, setBookSwitcherOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  // Let the command palette (and anything else) open the switchers via events
  useEffect(() => {
    const openAccounts = () => setAccountSwitcherOpen(true)
    const openBooks = () => setBookSwitcherOpen(true)
    window.addEventListener('open-account-switcher', openAccounts)
    window.addEventListener('open-book-switcher', openBooks)
    return () => {
      window.removeEventListener('open-account-switcher', openAccounts)
      window.removeEventListener('open-book-switcher', openBooks)
    }
  }, [])

  // Navigation shortcuts (chords)
  useKeyboardShortcut('nav-dashboard', 'g d', 'Go to Dashboard', () => router.push('/dashboard'))
  useKeyboardShortcut('nav-accounts', 'g a', 'Go to Accounts', () => router.push('/accounts'))
  useKeyboardShortcut('nav-ledger', 'g l', 'Go to Ledger', () => router.push('/ledger'))
  useKeyboardShortcut('nav-investments', 'g i', 'Go to Investments', () => router.push('/investments'))
  useKeyboardShortcut('nav-reports', 'g r', 'Go to Reports', () => router.push('/reports'))
  useKeyboardShortcut('nav-budgets', 'g u', 'Go to Budgets', () => router.push('/budgets'))
  useKeyboardShortcut('nav-goals', 'g o', 'Go to Goals', () => router.push('/goals'))
  useKeyboardShortcut('nav-tags', 'g t', 'Go to Tags', () => router.push('/tags'))
  useKeyboardShortcut('nav-tools', 'g w', 'Go to Tools', () => router.push('/tools'))
  useKeyboardShortcut('nav-settings', 'g s', 'Go to Settings', () => router.push('/settings'))

  // Quick switchers
  useKeyboardShortcut('command-palette', 'Ctrl+k', 'Command palette', () => {
    setPaletteOpen(true)
  })
  useKeyboardShortcut('quick-account-switcher', 'Ctrl+p', 'Quick account switcher', () => {
    setAccountSwitcherOpen(true)
  })
  useKeyboardShortcut('quick-book-switcher', 'g b', 'Switch book', () => {
    setBookSwitcherOpen(true)
  })

  // Focus the page's search/filter input ("/" like GitHub/Gmail). Works on
  // every page: prefers an explicitly tagged input, then falls back to any
  // visible search/filter field.
  useKeyboardShortcut('focus-search', '/', 'Focus search / filter', () => {
    const selectors = [
      'input[data-search-input]',
      'input[type="search"]',
      'input[placeholder*="earch" i]',
      'input[placeholder*="ilter" i]',
    ]
    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll<HTMLInputElement>(selector))
      const visible = candidates.find(el => el.offsetParent !== null && !el.disabled && !el.readOnly)
      if (visible) {
        visible.focus()
        visible.select()
        return
      }
    }
  })

  // New transaction shortcut
  useKeyboardShortcut('new-transaction', 'n', 'New Transaction', () => {
    window.dispatchEvent(new CustomEvent('open-new-transaction'))
  })
  useKeyboardShortcut('new-transaction-alt', 'Alt+n', 'New Transaction (from input)', () => {
    window.dispatchEvent(new CustomEvent('open-new-transaction'))
  })

  // Edit mode shortcuts
  useKeyboardShortcut('enter-edit-mode', 'e', 'Enter edit mode', () => {
    window.dispatchEvent(new CustomEvent('enter-edit-mode'))
  })

  // Escape to exit edit mode (only when no modal/dialog is open)
  useKeyboardShortcut('close-modal', 'Escape', 'Close modal / Exit edit mode', () => {
    // Don't exit edit mode if a modal or dialog is currently open
    const hasOpenModal = document.querySelector('[role="dialog"], [data-modal-open="true"]');
    if (hasOpenModal) return;
    window.dispatchEvent(new CustomEvent('exit-edit-mode'))
  })

  return (
    <>
      <CommandPalette isOpen={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <QuickAccountSwitcher isOpen={accountSwitcherOpen} onClose={() => setAccountSwitcherOpen(false)} />
      <QuickBookSwitcher isOpen={bookSwitcherOpen} onClose={() => setBookSwitcherOpen(false)} />
    </>
  )
}
