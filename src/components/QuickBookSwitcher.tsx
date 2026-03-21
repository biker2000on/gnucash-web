'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useBooks } from '@/contexts/BookContext'

interface QuickBookSwitcherProps {
  isOpen: boolean
  onClose: () => void
}

export function QuickBookSwitcher({ isOpen, onClose }: QuickBookSwitcherProps) {
  const { activeBookGuid, books, switchBook } = useBooks()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset state and set initial selection to active book when opening
  useEffect(() => {
    if (isOpen) {
      const activeIndex = books.findIndex(b => b.guid === activeBookGuid)
      setSelectedIndex(activeIndex >= 0 ? activeIndex : 0)
    }
  }, [isOpen, books, activeBookGuid])

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return
    const items = listRef.current.querySelectorAll('[data-item]')
    items[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleSelect = useCallback(async (guid: string) => {
    onClose()
    if (guid !== activeBookGuid) {
      await switchBook(guid)
    }
  }, [onClose, activeBookGuid, switchBook])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelectedIndex(i => Math.min(i + 1, books.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setSelectedIndex(i => Math.max(i - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        if (books[selectedIndex]) {
          handleSelect(books[selectedIndex].guid)
        }
        break
      case 'Escape':
        e.preventDefault()
        onClose()
        break
    }
  }, [books, selectedIndex, handleSelect, onClose])

  if (!isOpen || books.length === 0) return null

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-[15vh]" onKeyDown={handleKeyDown} tabIndex={-1} ref={el => el?.focus()}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Switcher panel */}
      <div className="relative w-full max-w-md bg-background-secondary border border-border rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <svg className="w-5 h-5 text-foreground-tertiary shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.25278C12 6.25278 10.5 3 7 3C3.5 3 2 5 2 7.5V19.5C2 19.5 3.5 18 7 18C10.5 18 12 20 12 20M12 6.25278C12 6.25278 13.5 3 17 3C20.5 3 22 5 22 7.5V19.5C22 19.5 20.5 18 17 18C13.5 18 12 20 12 20M12 6.25278V20" />
          </svg>
          <span className="text-sm font-medium text-foreground">Switch Book</span>
          <kbd className="ml-auto hidden sm:inline-flex text-xs text-foreground-tertiary bg-surface-hover px-1.5 py-0.5 rounded border border-border">
            esc
          </kbd>
        </div>

        {/* Books list */}
        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {books.map((book, index) => (
            <button
              key={book.guid}
              data-item
              onClick={() => handleSelect(book.guid)}
              className={`flex items-center gap-3 w-full px-4 py-3 text-left transition-colors ${
                index === selectedIndex
                  ? 'bg-accent-primary/15 text-foreground'
                  : 'text-foreground-secondary hover:bg-surface-hover'
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{book.name}</div>
                {book.description && (
                  <div className="text-xs text-foreground-tertiary truncate mt-0.5">{book.description}</div>
                )}
              </div>
              {book.guid === activeBookGuid && (
                <svg className="w-4 h-4 shrink-0 text-accent-primary" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          ))}
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
