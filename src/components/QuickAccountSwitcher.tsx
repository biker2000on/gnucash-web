'use client'

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createPortal } from 'react-dom'
import { useAccounts } from '@/lib/hooks/useAccounts'
import { Account } from '@/lib/types'

/** Strip the root/book account name (first colon-delimited segment) from fullname */
function stripRoot(fullname: string): string {
  const idx = fullname.indexOf(':')
  return idx >= 0 ? fullname.slice(idx + 1) : fullname
}

interface QuickAccountSwitcherProps {
  isOpen: boolean
  onClose: () => void
}

export function QuickAccountSwitcher({ isOpen, onClose }: QuickAccountSwitcherProps) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { data: accounts } = useAccounts({ flat: true })

  const filtered = useMemo(() => {
    if (!accounts) return []
    const flat = accounts as Account[]
    // Exclude ROOT type accounts
    const eligible = flat.filter(a => a.account_type !== 'ROOT')
    if (!query.trim()) return eligible
    const lower = query.toLowerCase()
    return eligible.filter(a => {
      const display = stripRoot(a.fullname || a.name)
      return display.toLowerCase().includes(lower)
    })
  }, [accounts, query])

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setSelectedIndex(0)
      // Focus input after render
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [isOpen])

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return
    const items = listRef.current.querySelectorAll('[data-item]')
    items[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleSelect = useCallback((account: Account) => {
    onClose()
    router.push(`/accounts/${account.guid}`)
  }, [onClose, router])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelectedIndex(i => Math.min(i + 1, filtered.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setSelectedIndex(i => Math.max(i - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        if (filtered[selectedIndex]) {
          handleSelect(filtered[selectedIndex])
        }
        break
      case 'Escape':
        e.preventDefault()
        onClose()
        break
    }
  }, [filtered, selectedIndex, handleSelect, onClose])

  // Reset selected index when filter changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  if (!isOpen) return null

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-[15vh]" onKeyDown={handleKeyDown}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Switcher panel */}
      <div className="relative w-full max-w-2xl bg-background-secondary border border-border rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <svg className="w-5 h-5 text-foreground-tertiary shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search accounts..."
            className="flex-1 bg-transparent text-foreground placeholder:text-foreground-tertiary outline-none text-sm"
          />
          <kbd className="hidden sm:inline-flex text-xs text-foreground-tertiary bg-surface-hover px-1.5 py-0.5 rounded border border-border">
            esc
          </kbd>
        </div>

        {/* Results list */}
        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-foreground-tertiary">
              {accounts ? 'No accounts found' : 'Loading...'}
            </div>
          ) : (
            filtered.map((account, index) => (
                <button
                  key={account.guid}
                  data-item
                  onClick={() => handleSelect(account)}
                  className={`w-full px-4 py-2 text-left text-sm transition-colors ${
                    index === selectedIndex
                      ? 'bg-accent-primary/15 text-foreground'
                      : 'text-foreground-secondary hover:bg-surface-hover'
                  }`}
                >
                  {stripRoot(account.fullname || account.name)}
                </button>
              ))

          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-border text-xs text-foreground-tertiary">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded border border-border bg-surface-hover">&uarr;</kbd>
            <kbd className="px-1 py-0.5 rounded border border-border bg-surface-hover">&darr;</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded border border-border bg-surface-hover">&crarr;</kbd>
            open
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded border border-border bg-surface-hover">esc</kbd>
            close
          </span>
        </div>
      </div>
    </div>,
    document.body
  )
}
