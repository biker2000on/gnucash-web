'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut'
import { QuickAccountSwitcher } from './QuickAccountSwitcher'
import { QuickBookSwitcher } from './QuickBookSwitcher'

export function GlobalShortcuts() {
  const router = useRouter()
  const [accountSwitcherOpen, setAccountSwitcherOpen] = useState(false)
  const [bookSwitcherOpen, setBookSwitcherOpen] = useState(false)

  // Navigation shortcuts (chords)
  useKeyboardShortcut('nav-dashboard', 'g d', 'Go to Dashboard', () => router.push('/dashboard'))
  useKeyboardShortcut('nav-accounts', 'g a', 'Go to Accounts', () => router.push('/accounts'))
  useKeyboardShortcut('nav-ledger', 'g l', 'Go to Ledger', () => router.push('/ledger'))
  useKeyboardShortcut('nav-investments', 'g i', 'Go to Investments', () => router.push('/investments'))
  useKeyboardShortcut('nav-reports', 'g r', 'Go to Reports', () => router.push('/reports'))

  // Quick switchers
  useKeyboardShortcut('quick-account-switcher', 'Ctrl+p', 'Quick account switcher', () => {
    setAccountSwitcherOpen(true)
  })
  useKeyboardShortcut('quick-book-switcher', 'g b', 'Switch book', () => {
    setBookSwitcherOpen(true)
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
      <QuickAccountSwitcher isOpen={accountSwitcherOpen} onClose={() => setAccountSwitcherOpen(false)} />
      <QuickBookSwitcher isOpen={bookSwitcherOpen} onClose={() => setBookSwitcherOpen(false)} />
    </>
  )
}
