'use client'

import { useRouter } from 'next/navigation'
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut'

export function GlobalShortcuts() {
  const router = useRouter()

  // Navigation shortcuts (chords)
  useKeyboardShortcut('nav-dashboard', 'g d', 'Go to Dashboard', () => router.push('/dashboard'))
  useKeyboardShortcut('nav-accounts', 'g a', 'Go to Accounts', () => router.push('/accounts'))
  useKeyboardShortcut('nav-ledger', 'g l', 'Go to Ledger', () => router.push('/ledger'))
  useKeyboardShortcut('nav-investments', 'g i', 'Go to Investments', () => router.push('/investments'))
  useKeyboardShortcut('nav-reports', 'g r', 'Go to Reports', () => router.push('/reports'))

  // New transaction shortcut
  useKeyboardShortcut('new-transaction', 'n', 'New Transaction', () => {
    window.dispatchEvent(new CustomEvent('open-new-transaction'))
  })

  // Edit mode shortcuts
  useKeyboardShortcut('enter-edit-mode', 'e', 'Enter edit mode', () => {
    window.dispatchEvent(new CustomEvent('enter-edit-mode'))
  })

  // Escape to close modal / exit edit mode
  useKeyboardShortcut('close-modal', 'Escape', 'Close modal / Exit edit mode', () => {
    window.dispatchEvent(new CustomEvent('exit-edit-mode'))
  })

  return null
}
