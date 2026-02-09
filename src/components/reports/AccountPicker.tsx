'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';

interface FlatAccount {
    guid: string;
    name: string;
    account_type: string;
    parent_guid: string | null;
    fullname?: string;
    commodity_mnemonic?: string;
}

interface AccountTreeNode {
    guid: string;
    name: string;
    account_type: string;
    fullname: string;
    depth: number;
    hasChildren: boolean;
    parentGuid: string | null;
}

interface AccountPickerProps {
    selectedGuids: string[];
    onChange: (guids: string[]) => void;
    allowedAccountTypes?: string[];
    placeholder?: string;
}

export function AccountPicker({
    selectedGuids,
    onChange,
    allowedAccountTypes,
    placeholder = 'Select accounts...',
}: AccountPickerProps) {
    const [rawAccounts, setRawAccounts] = useState<FlatAccount[]>([]);
    const [isOpen, setIsOpen] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

    useEffect(() => {
        fetchAccounts();
    }, []);

    const fetchAccounts = async () => {
        setIsLoading(true);
        try {
            const response = await fetch('/api/accounts?flat=true');
            if (!response.ok) throw new Error('Failed to fetch accounts');
            const data = await response.json();
            const accounts: FlatAccount[] = (data.accounts || data).map((a: any) => ({
                guid: a.guid,
                name: a.name,
                account_type: a.account_type,
                parent_guid: a.parent_guid || null,
                fullname: a.fullname || a.full_name || a.name,
                commodity_mnemonic: a.commodity_mnemonic,
            }));
            setRawAccounts(accounts);
        } catch {
            // silently fail - empty list shown
        } finally {
            setIsLoading(false);
        }
    };

    // Build tree from flat accounts
    const { treeNodes, visibleNodes, accountTypes } = useMemo(() => {
        if (!rawAccounts.length) return { treeNodes: [] as AccountTreeNode[], visibleNodes: [] as AccountTreeNode[], accountTypes: [] as string[] };

        // Filter by allowed types if specified
        const filteredAccounts = allowedAccountTypes
            ? rawAccounts.filter(a => allowedAccountTypes.includes(a.account_type))
            : rawAccounts.filter(a => a.account_type !== 'ROOT');

        // Collect all raw account GUIDs for parent resolution
        const allGuids = new Set(rawAccounts.map(a => a.guid));
        const filteredGuids = new Set(filteredAccounts.map(a => a.guid));

        // Build children map
        const childrenMap = new Map<string | 'root', FlatAccount[]>();
        for (const acc of filteredAccounts) {
            const parentKey = acc.parent_guid && allGuids.has(acc.parent_guid) ? acc.parent_guid : 'root';
            if (!childrenMap.has(parentKey)) {
                childrenMap.set(parentKey, []);
            }
            childrenMap.get(parentKey)!.push(acc);
        }

        // Sort children alphabetically
        for (const [, children] of childrenMap) {
            children.sort((a, b) => a.name.localeCompare(b.name));
        }

        // Determine which filtered accounts have children
        const parentGuids = new Set<string>();
        for (const acc of filteredAccounts) {
            if (acc.parent_guid && filteredGuids.has(acc.parent_guid)) {
                parentGuids.add(acc.parent_guid);
            }
        }

        // Also check childrenMap for accounts whose parent is not in filteredGuids but is in allGuids
        // These would appear as root-level parents in the tree
        for (const [key, children] of childrenMap) {
            if (key !== 'root' && children.length > 0) {
                parentGuids.add(key);
            }
        }

        // Flatten tree into ordered list
        const allNodes: AccountTreeNode[] = [];
        const buildTree = (parentKey: string | 'root', depth: number) => {
            const children = childrenMap.get(parentKey) || [];
            for (const acc of children) {
                const hasChildren = parentGuids.has(acc.guid) || (childrenMap.has(acc.guid) && childrenMap.get(acc.guid)!.length > 0);
                allNodes.push({
                    guid: acc.guid,
                    name: acc.name,
                    account_type: acc.account_type,
                    fullname: acc.fullname || acc.name,
                    depth,
                    hasChildren,
                    parentGuid: acc.parent_guid,
                });
                buildTree(acc.guid, depth + 1);
            }
        };
        buildTree('root', 0);

        // Collect unique account types from visible accounts
        const types = Array.from(new Set(filteredAccounts.map(a => a.account_type))).sort();

        // Determine visible nodes based on search and expansion
        let visible: AccountTreeNode[];
        if (searchTerm.trim()) {
            const term = searchTerm.toLowerCase();
            // Find matching nodes
            const matchingGuids = new Set(
                allNodes
                    .filter(node => node.name.toLowerCase().includes(term) || node.fullname.toLowerCase().includes(term))
                    .map(n => n.guid)
            );
            // Also include ancestors of matches for context
            const ancestorGuids = new Set<string>();
            for (const node of allNodes) {
                if (matchingGuids.has(node.guid)) {
                    // Walk up the tree to find ancestors
                    let current = node;
                    while (current.parentGuid) {
                        const parent = allNodes.find(n => n.guid === current.parentGuid);
                        if (parent) {
                            ancestorGuids.add(parent.guid);
                            current = parent;
                        } else {
                            break;
                        }
                    }
                }
            }
            visible = allNodes.filter(node => matchingGuids.has(node.guid) || ancestorGuids.has(node.guid));
        } else {
            // Respect expanded state
            visible = [];
            const visibleParents = new Set<string | 'root'>(['root']);
            for (const node of allNodes) {
                const parentKey = (() => {
                    const acc = filteredAccounts.find(a => a.guid === node.guid);
                    if (!acc) return 'root';
                    return acc.parent_guid && allGuids.has(acc.parent_guid) ? acc.parent_guid : 'root';
                })();
                if (visibleParents.has(parentKey)) {
                    visible.push(node);
                    if (node.hasChildren && expandedNodes.has(node.guid)) {
                        visibleParents.add(node.guid);
                    }
                }
            }
        }

        return { treeNodes: allNodes, visibleNodes: visible, accountTypes: types };
    }, [rawAccounts, searchTerm, expandedNodes, allowedAccountTypes]);

    const toggleExpand = useCallback((guid: string) => {
        setExpandedNodes(prev => {
            const next = new Set(prev);
            if (next.has(guid)) {
                next.delete(guid);
            } else {
                next.add(guid);
            }
            return next;
        });
    }, []);

    const toggleSelect = useCallback((guid: string) => {
        const isSelected = selectedGuids.includes(guid);
        if (isSelected) {
            onChange(selectedGuids.filter(g => g !== guid));
        } else {
            onChange([...selectedGuids, guid]);
        }
    }, [selectedGuids, onChange]);

    const selectAll = useCallback(() => {
        const allGuids = treeNodes.map(n => n.guid);
        onChange(allGuids);
    }, [treeNodes, onChange]);

    const deselectAll = useCallback(() => {
        onChange([]);
    }, [onChange]);

    const selectByType = useCallback((type: string) => {
        const typeGuids = treeNodes.filter(n => n.account_type === type).map(n => n.guid);
        // Add type guids to current selection (union)
        const merged = new Set([...selectedGuids, ...typeGuids]);
        onChange(Array.from(merged));
    }, [treeNodes, selectedGuids, onChange]);

    const removeSelected = useCallback((guid: string) => {
        onChange(selectedGuids.filter(g => g !== guid));
    }, [selectedGuids, onChange]);

    // Build a map for quick name lookups
    const accountNameMap = useMemo(() => {
        const map = new Map<string, string>();
        for (const acc of rawAccounts) {
            map.set(acc.guid, acc.name);
        }
        return map;
    }, [rawAccounts]);

    const selectedSet = useMemo(() => new Set(selectedGuids), [selectedGuids]);

    return (
        <div className="border border-border rounded-lg">
            {/* Collapsed header / toggle */}
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className="w-full flex items-center justify-between px-3 py-2 text-sm text-left hover:bg-surface-hover transition-colors"
            >
                <span className="text-foreground-secondary">
                    {selectedGuids.length > 0
                        ? `${selectedGuids.length} account${selectedGuids.length === 1 ? '' : 's'} selected`
                        : placeholder}
                </span>
                <svg
                    className={`w-4 h-4 text-foreground-muted transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </button>

            {/* Selected account chips */}
            {selectedGuids.length > 0 && !isOpen && (
                <div className="flex flex-wrap gap-1 px-3 pb-2">
                    {selectedGuids.slice(0, 10).map(guid => (
                        <span
                            key={guid}
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-cyan-500/10 text-cyan-400 rounded-full"
                        >
                            {accountNameMap.get(guid) || guid.slice(0, 8)}
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); removeSelected(guid); }}
                                className="hover:text-cyan-200 transition-colors"
                            >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </span>
                    ))}
                    {selectedGuids.length > 10 && (
                        <span className="text-xs text-foreground-muted px-1">
                            +{selectedGuids.length - 10} more
                        </span>
                    )}
                </div>
            )}

            {/* Expanded panel */}
            {isOpen && (
                <div>
                    {/* Search input */}
                    <div className="border-b border-border">
                        <input
                            type="text"
                            placeholder="Search accounts..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="w-full px-3 py-2 bg-input-bg border-0 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:ring-0"
                            autoFocus
                        />
                    </div>

                    {/* Quick action bar */}
                    <div className="flex flex-wrap items-center gap-1 px-3 py-2 border-b border-border bg-background-secondary">
                        <button
                            type="button"
                            onClick={selectAll}
                            className="text-xs text-foreground-secondary hover:text-foreground px-2 py-1 rounded hover:bg-surface-hover transition-colors"
                        >
                            Select All
                        </button>
                        <button
                            type="button"
                            onClick={deselectAll}
                            className="text-xs text-foreground-secondary hover:text-foreground px-2 py-1 rounded hover:bg-surface-hover transition-colors"
                        >
                            Deselect All
                        </button>
                        <span className="w-px h-4 bg-border mx-1" />
                        {accountTypes.map(type => (
                            <button
                                key={type}
                                type="button"
                                onClick={() => selectByType(type)}
                                className="text-xs text-foreground-tertiary hover:text-foreground px-1.5 py-0.5 rounded bg-background-tertiary hover:bg-surface-hover transition-colors"
                            >
                                All {type}
                            </button>
                        ))}
                    </div>

                    {/* Account tree */}
                    <div className="max-h-64 overflow-y-auto">
                        {isLoading ? (
                            <div className="p-4 text-center text-foreground-secondary text-sm">Loading accounts...</div>
                        ) : visibleNodes.length === 0 ? (
                            <div className="p-4 text-center text-foreground-secondary text-sm">
                                {searchTerm ? 'No matching accounts found' : 'No accounts available'}
                            </div>
                        ) : (
                            <ul>
                                {visibleNodes.map((node) => (
                                    <li key={node.guid}>
                                        <div
                                            className="flex items-center px-3 py-1.5 hover:bg-surface-hover text-sm transition-colors"
                                            style={{ paddingLeft: searchTerm ? '12px' : `${12 + node.depth * 20}px` }}
                                        >
                                            {/* Expand/collapse toggle */}
                                            {!searchTerm && node.hasChildren ? (
                                                <button
                                                    type="button"
                                                    onClick={() => toggleExpand(node.guid)}
                                                    className="p-0.5 mr-1.5 rounded hover:bg-border-hover transition-colors flex-shrink-0"
                                                >
                                                    <svg
                                                        className={`w-3.5 h-3.5 text-foreground-muted transition-transform ${expandedNodes.has(node.guid) ? 'rotate-90' : ''}`}
                                                        fill="none"
                                                        stroke="currentColor"
                                                        viewBox="0 0 24 24"
                                                    >
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                                    </svg>
                                                </button>
                                            ) : !searchTerm ? (
                                                <span className="w-[22px] mr-1.5 flex-shrink-0" />
                                            ) : null}

                                            {/* Checkbox */}
                                            <input
                                                type="checkbox"
                                                checked={selectedSet.has(node.guid)}
                                                onChange={() => toggleSelect(node.guid)}
                                                className="mr-2 accent-cyan-500 flex-shrink-0"
                                            />

                                            {/* Account name */}
                                            <span className="truncate text-foreground">
                                                {searchTerm ? node.fullname : node.name}
                                            </span>

                                            {/* Type badge */}
                                            <span className="ml-auto text-xs px-1.5 py-0.5 rounded bg-background-tertiary text-foreground-tertiary flex-shrink-0">
                                                {node.account_type}
                                            </span>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
