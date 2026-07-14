'use client'

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createPortal } from 'react-dom'
import { useAccounts } from '@/lib/hooks/useAccounts'
import { useKeyboardShortcuts } from '@/contexts/KeyboardShortcutContext'
import { Account } from '@/lib/types'
import { searchCommands, fuzzyScore, recordPaletteUse, recentPaletteCommands, ScoredCommand } from '@/lib/command-palette'
import { FEATURES } from '@/lib/feature-registry'
import { isFeatureVisible, useBookGating } from '@/lib/hooks/useBookGating'
import { formatCurrency } from '@/lib/format'

/** Strip the root/book account name (first colon-delimited segment) from fullname */
function stripRoot(fullname: string): string {
  const idx = fullname.indexOf(':')
  return idx >= 0 ? fullname.slice(idx + 1) : fullname
}

interface TxHit {
  guid: string
  description: string
  post_date: string
  splits?: Array<{ account_guid: string; account_fullname?: string; value_decimal?: string; commodity_mnemonic?: string }>
}

type PaletteRow =
  | { kind: 'command'; command: ScoredCommand }
  | { kind: 'account'; account: Account; score: number }
  | { kind: 'transaction'; tx: TxHit }

const GROUP_LABELS: Record<string, string> = {
  action: 'Actions',
  navigate: 'Navigate',
  report: 'Reports',
  tool: 'Tools',
  business: 'Business',
  account: 'Accounts',
  transaction: 'Transactions',
}

function rowGroup(row: PaletteRow): string {
  if (row.kind === 'command') return row.command.group
  return row.kind
}

interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
}

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const router = useRouter()
  const { setHelpOpen } = useKeyboardShortcuts()
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [txHits, setTxHits] = useState<TxHit[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { data: accounts } = useAccounts({ flat: true })

  // Book gating: business books hide personal-only features; disabled
  // feature modules hide their gated business features.
  const { businessBook, features: bookFeatures } = useBookGating()
  const hiddenFeatureIds = useMemo(() => {
    const hidden = new Set<string>()
    for (const f of FEATURES) {
      if (!isFeatureVisible(f, businessBook, bookFeatures)) hidden.add(f.id)
    }
    return hidden
  }, [businessBook, bookFeatures])

  // Debounced transaction search once the query is meaningful
  useEffect(() => {
    if (!isOpen) return
    const q = query.trim()
    if (q.length < 3) {
      setTxHits([])
      return
    }
    const timer = setTimeout(() => {
      fetch(`/api/transactions?search=${encodeURIComponent(q)}&limit=5`)
        .then(r => (r.ok ? r.json() : []))
        .then((data) => {
          const list = Array.isArray(data) ? data : data?.transactions
          setTxHits(Array.isArray(list) ? list.slice(0, 5) : [])
        })
        .catch(() => setTxHits([]))
    }, 250)
    return () => clearTimeout(timer)
  }, [query, isOpen])

  const rows = useMemo<PaletteRow[]>(() => {
    const q = query.trim()
    // Empty query: recently used commands lead, then actions + navigation
    const recents: PaletteRow[] = !q
      ? recentPaletteCommands()
          .filter(c => !hiddenFeatureIds.has(c.id))
          .map(command => ({ kind: 'command' as const, command: { ...command, score: 3 } }))
      : []
    const recentIds = new Set(recents.map(r => (r as { command: ScoredCommand }).command.id))
    const commandRows: PaletteRow[] = [
      ...recents,
      ...searchCommands(q)
        .filter(c => !recentIds.has(c.id) && !hiddenFeatureIds.has(c.id))
        .slice(0, q ? 8 : 10)
        .map(command => ({ kind: 'command' as const, command })),
    ]

    let accountRows: PaletteRow[] = []
    if (q && accounts) {
      const flat = accounts as Account[]
      accountRows = flat
        .filter(a => a.account_type !== 'ROOT')
        .map(a => {
          const display = stripRoot(a.fullname || a.name)
          return { kind: 'account' as const, account: a, score: fuzzyScore(q, display) }
        })
        .filter(r => r.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
    }

    const txRows: PaletteRow[] = q.length >= 3
      ? txHits.map(tx => ({ kind: 'transaction' as const, tx }))
      : []

    // Interleave: strong command hits first, then accounts, weak commands, transactions
    const strong = commandRows.filter(r => r.kind === 'command' && r.command.score >= 250)
    const weak = commandRows.filter(r => r.kind === 'command' && r.command.score < 250)
    return [...strong, ...accountRows, ...weak, ...txRows]
  }, [query, accounts, txHits, hiddenFeatureIds])

  useEffect(() => {
    if (isOpen) {
      const frame = requestAnimationFrame(() => {
        setQuery('')
        setTxHits([])
        setSelectedIndex(0)
        inputRef.current?.focus()
      })
      return () => cancelAnimationFrame(frame)
    }
  }, [isOpen])

  useEffect(() => {
    if (!listRef.current) return
    const items = listRef.current.querySelectorAll('[data-item]')
    items[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  useEffect(() => {
    const frame = requestAnimationFrame(() => setSelectedIndex(0))
    return () => cancelAnimationFrame(frame)
  }, [query])

  const handleSelect = useCallback((row: PaletteRow) => {
    onClose()
    if (row.kind === 'command') {
      const { command } = row
      recordPaletteUse(command.id)
      if (command.event === 'open-shortcut-help') {
        setHelpOpen(true)
      } else if (command.event) {
        window.dispatchEvent(new CustomEvent(command.event))
      } else if (command.href) {
        router.push(command.href)
      }
    } else if (row.kind === 'account') {
      router.push(`/accounts/${row.account.guid}`)
    } else {
      router.push(`/ledger?search=${encodeURIComponent(row.tx.description)}`)
    }
  }, [onClose, router, setHelpOpen])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelectedIndex(i => Math.min(i + 1, rows.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setSelectedIndex(i => Math.max(i - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        if (rows[selectedIndex]) handleSelect(rows[selectedIndex])
        break
      case 'Escape':
        e.preventDefault()
        onClose()
        break
    }
  }, [rows, selectedIndex, handleSelect, onClose])

  if (!isOpen) return null

  // Group headers are rendered whenever the group changes between rows
  let lastGroup = ''

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-[15vh]" onKeyDown={handleKeyDown}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-2xl bg-background-secondary border border-border rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <svg className="w-5 h-5 text-foreground-tertiary shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search commands, pages, accounts, transactions…"
            className="flex-1 bg-transparent text-foreground placeholder:text-foreground-tertiary outline-none text-sm"
          />
          <kbd className="hidden sm:inline-flex text-xs text-foreground-tertiary bg-surface-hover px-1.5 py-0.5 rounded border border-border">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-96 overflow-y-auto py-1">
          {rows.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-foreground-tertiary">
              {query ? 'No matches' : 'Loading…'}
            </div>
          ) : (
            rows.map((row, index) => {
              const group = rowGroup(row)
              const showHeader = group !== lastGroup
              lastGroup = group
              const selected = index === selectedIndex
              return (
                <div key={row.kind === 'command' ? row.command.id : row.kind === 'account' ? row.account.guid : row.tx.guid}>
                  {showHeader && (
                    <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-foreground-tertiary font-semibold">
                      {GROUP_LABELS[group] ?? group}
                    </div>
                  )}
                  <button
                    data-item
                    onClick={() => handleSelect(row)}
                    onMouseMove={() => setSelectedIndex(index)}
                    className={`w-full px-4 py-2 text-left text-sm transition-colors flex items-center justify-between gap-3 ${
                      selected
                        ? 'bg-accent-primary/15 text-foreground'
                        : 'text-foreground-secondary hover:bg-surface-hover'
                    }`}
                  >
                    {row.kind === 'command' && (
                      <>
                        <span>{row.command.title}</span>
                        {row.command.shortcut && (
                          <kbd className="shrink-0 text-[10px] text-foreground-tertiary bg-surface-hover px-1.5 py-0.5 rounded border border-border">
                            {row.command.shortcut}
                          </kbd>
                        )}
                      </>
                    )}
                    {row.kind === 'account' && (
                      <span className="truncate">{stripRoot(row.account.fullname || row.account.name)}</span>
                    )}
                    {row.kind === 'transaction' && (
                      <>
                        <span className="truncate">{row.tx.description}</span>
                        <span className="shrink-0 text-xs text-foreground-tertiary font-mono">
                          {new Date(row.tx.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' })}
                          {row.tx.splits?.[0]?.value_decimal != null && (
                            <> · {formatCurrency(Math.abs(parseFloat(row.tx.splits[0].value_decimal)), row.tx.splits[0].commodity_mnemonic || 'USD')}</>
                          )}
                        </span>
                      </>
                    )}
                  </button>
                </div>
              )
            })
          )}
        </div>

        <div className="flex items-center gap-4 px-4 py-2 border-t border-border text-xs text-foreground-tertiary">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded border border-border bg-surface-hover">&uarr;</kbd>
            <kbd className="px-1 py-0.5 rounded border border-border bg-surface-hover">&darr;</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded border border-border bg-surface-hover">&crarr;</kbd>
            select
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
