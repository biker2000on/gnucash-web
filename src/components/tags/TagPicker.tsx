'use client';

/**
 * Tag autocomplete combobox (modeled on ui/DescriptionAutocomplete).
 * Type to filter existing tags, create new tags inline, full keyboard nav.
 * Operates on a controlled list of selected tag names.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import TagChip from './TagChip';
import { normalizeTagName, isValidTagName, type Tag } from '@/lib/tags';

export interface SelectedTag {
    name: string;
    color?: string | null;
}

interface TagPickerProps {
    selected: SelectedTag[];
    onChange: (tags: SelectedTag[]) => void;
    placeholder?: string;
    autoFocus?: boolean;
    className?: string;
}

export function TagPicker({ selected, onChange, placeholder = 'Add tags...', autoFocus, className = '' }: TagPickerProps) {
    const [allTags, setAllTags] = useState<Tag[]>([]);
    const [query, setQuery] = useState('');
    const [isOpen, setIsOpen] = useState(false);
    const [focusedIndex, setFocusedIndex] = useState(0);
    const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // Load the global tag list once
    useEffect(() => {
        let cancelled = false;
        fetch('/api/tags')
            .then(res => (res.ok ? res.json() : []))
            .then((tags: Tag[]) => { if (!cancelled) setAllTags(tags); })
            .catch(() => { /* picker still works for inline creation */ });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        if (autoFocus) inputRef.current?.focus();
    }, [autoFocus]);

    const selectedNames = useMemo(() => new Set(selected.map(t => t.name)), [selected]);
    const normalizedQuery = normalizeTagName(query);

    const suggestions = useMemo(() => {
        const available = allTags.filter(t => !selectedNames.has(t.name));
        if (!normalizedQuery) return available.slice(0, 10);
        return available
            .filter(t => t.name.includes(normalizedQuery))
            .slice(0, 10);
    }, [allTags, selectedNames, normalizedQuery]);

    const canCreate =
        normalizedQuery.length > 0 &&
        isValidTagName(normalizedQuery) &&
        !selectedNames.has(normalizedQuery) &&
        !allTags.some(t => t.name === normalizedQuery);

    // Options: existing suggestions, then optional "create" row
    const optionCount = suggestions.length + (canCreate ? 1 : 0);

    // Position the portal dropdown
    useEffect(() => {
        if (isOpen && containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            setDropdownStyle({
                position: 'fixed',
                top: rect.bottom + 4,
                left: rect.left,
                width: rect.width,
                zIndex: 99999,
            });
        }
    }, [isOpen, selected.length]);

    // Close on outside click
    useEffect(() => {
        if (!isOpen) return;
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (!containerRef.current?.contains(target) && !target.closest?.('[data-tag-dropdown]')) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    const addTag = (tag: SelectedTag) => {
        if (selectedNames.has(tag.name)) return;
        onChange([...selected, tag]);
        setQuery('');
        setIsOpen(true);
        inputRef.current?.focus();
    };

    const removeTag = (name: string) => {
        onChange(selected.filter(t => t.name !== name));
    };

    const selectOption = (index: number) => {
        if (index < suggestions.length) {
            const tag = suggestions[index];
            addTag({ name: tag.name, color: tag.color });
        } else if (canCreate) {
            addTag({ name: normalizedQuery });
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setIsOpen(true);
            setFocusedIndex(prev => Math.min(prev + 1, Math.max(optionCount - 1, 0)));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setFocusedIndex(prev => Math.max(prev - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (isOpen && optionCount > 0) {
                selectOption(Math.min(focusedIndex, optionCount - 1));
            } else if (canCreate) {
                addTag({ name: normalizedQuery });
            }
        } else if (e.key === 'Backspace' && query === '' && selected.length > 0) {
            removeTag(selected[selected.length - 1].name);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setIsOpen(false);
        }
    };

    return (
        <div ref={containerRef} className={`relative ${className}`}>
            <div
                className="flex flex-wrap items-center gap-1.5 w-full bg-input-bg border border-border rounded-lg px-2 py-1.5 min-h-[38px] focus-within:border-primary/50 transition-colors cursor-text"
                onClick={() => inputRef.current?.focus()}
            >
                {selected.map(tag => (
                    <TagChip
                        key={tag.name}
                        name={tag.name}
                        color={tag.color}
                        size="sm"
                        onRemove={() => removeTag(tag.name)}
                    />
                ))}
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => {
                        setQuery(e.target.value);
                        setFocusedIndex(0);
                        setIsOpen(true);
                    }}
                    onFocus={() => setIsOpen(true)}
                    onKeyDown={handleKeyDown}
                    placeholder={selected.length === 0 ? placeholder : ''}
                    className="flex-1 min-w-[100px] bg-transparent text-sm text-foreground placeholder-foreground-muted focus:outline-none py-0.5"
                />
            </div>

            {isOpen && (suggestions.length > 0 || canCreate) && typeof document !== 'undefined' && createPortal(
                <div
                    data-tag-dropdown
                    style={dropdownStyle}
                    className="bg-surface-elevated border border-border rounded-lg shadow-xl max-h-56 overflow-y-auto p-1"
                >
                    {suggestions.map((tag, index) => (
                        <button
                            key={tag.id}
                            type="button"
                            onMouseEnter={() => setFocusedIndex(index)}
                            onClick={() => selectOption(index)}
                            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                                index === focusedIndex ? 'bg-surface-hover text-foreground' : 'text-foreground-secondary'
                            }`}
                        >
                            <TagChip name={tag.name} color={tag.color} />
                            {typeof tag.transaction_count === 'number' && (
                                <span className="ml-auto text-xs text-foreground-muted">
                                    {tag.transaction_count + (tag.account_count ?? 0)} uses
                                </span>
                            )}
                        </button>
                    ))}
                    {canCreate && (
                        <button
                            type="button"
                            onMouseEnter={() => setFocusedIndex(suggestions.length)}
                            onClick={() => selectOption(suggestions.length)}
                            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                                focusedIndex === suggestions.length ? 'bg-surface-hover text-foreground' : 'text-foreground-secondary'
                            }`}
                        >
                            <span className="text-primary">+</span>
                            Create tag <TagChip name={normalizedQuery} />
                        </button>
                    )}
                </div>,
                document.body
            )}
        </div>
    );
}
