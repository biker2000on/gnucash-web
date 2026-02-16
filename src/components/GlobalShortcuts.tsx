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
    // Dispatch custom event that transaction form can listen to
    window.dispatchEvent(new CustomEvent('open-new-transaction'))
  })

  // Escape to close modal (just register for help display - Modal component handles it)
  useKeyboardShortcut('close-modal', 'Escape', 'Close modal', () => {
    // This is actually handled by Modal component, but we register it for help display
  })

  return null
}
