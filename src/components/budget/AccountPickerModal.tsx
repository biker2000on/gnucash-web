'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Modal } from '@/components/ui/Modal';

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
    isBudgeted: boolean;
}

interface Account {
    guid: string;
    name: string;
    account_type: string;
    full_name?: string;
}

interface AccountPickerModalProps {
    isOpen: boolean;
    onClose: () => void;
    budgetGuid: string;
    existingAccountGuids: string[];
    onAccountAdded: (account: Account) => void;
}

const BUDGETABLE_TYPES = ['INCOME', 'EXPENSE', 'ASSET', 'LIABILITY', 'BANK', 'CASH', 'CREDIT'];

export function AccountPickerModal({
    isOpen,
    onClose,
    budgetGuid,
    existingAccountGuids,
    onAccountAdded
}: AccountPickerModalProps) {
    const [rawAccounts, setRawAccounts] = useState<FlatAccount[]>([]);
    const [searchTerm, setSearchTerm] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isAdding, setIsAdding] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

    useEffect(() => {
        if (isOpen) {
            fetchAccounts();
            setSearchTerm('');
            setExpandedNodes(new Set());
        }
    }, [isOpen]);

    const fetchAccounts = async () => {
        setIsLoading(true);
        setError(null);
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
        } catch (err) {
            setError('Failed to load accounts');
        } finally {
            setIsLoading(false);
        }
    };

    // Build tree structure from flat accounts
    const { treeNodes, visibleNodes } = useMemo(() => {
        if (!rawAccounts.length) return { treeNodes: [] as AccountTreeNode[], visibleNodes: [] as AccountTreeNode[] };

        const budgetableAccounts = rawAccounts.filter(a => BUDGETABLE_TYPES.includes(a.account_type));

        // Build a set of all account GUIDs that are in our list (for hierarchy resolution)
        const allGuids = new Set(rawAccounts.map(a => a.guid));

        // Build children map
        const childrenMap = new Map<string | 'root', FlatAccount[]>();
        for (const acc of budgetableAccounts) {
            // If parent is in our set, it's a child; otherwise it's a root-level account
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

        // Check which accounts have children (among budgetable accounts)
        const parentGuids = new Set<string>();
        for (const acc of budgetableAccounts) {
            if (acc.parent_guid && allGuids.has(acc.parent_guid)) {
                parentGuids.add(acc.parent_guid);
            }
        }

        // Existing budget GUIDs set for fast lookup
        const existingSet = new Set(existingAccountGuids);

        // Flatten tree into ordered list with depth
        const allNodes: AccountTreeNode[] = [];
        const buildTree = (parentKey: string | 'root', depth: number) => {
            const children = childrenMap.get(parentKey) || [];
            for (const acc of children) {
                const hasChildren = parentGuids.has(acc.guid) || (childrenMap.has(acc.guid) && (childrenMap.get(acc.guid)!.length > 0));
                allNodes.push({
                    guid: acc.guid,
                    name: acc.name,
                    account_type: acc.account_type,
                    fullname: acc.fullname || acc.name,
                    depth,
                    hasChildren,
                    isBudgeted: existingSet.has(acc.guid),
                });
                buildTree(acc.guid, depth + 1);
            }
        };
        buildTree('root', 0);

        // When searching, filter to matching nodes (and show them flattened with full path)
        let visible: AccountTreeNode[];
        if (searchTerm.trim()) {
            const term = searchTerm.toLowerCase();
            visible = allNodes.filter(node =>
                node.name.toLowerCase().includes(term) ||
                node.fullname.toLowerCase().includes(term)
            );
        } else {
            // Respect expanded state for tree view
            visible = [];
            const expandedSet = expandedNodes;
            const visibleParents = new Set<string | 'root'>(['root']);

            for (const node of allNodes) {
                // A node is visible if its parent path is expanded
                // We need to check if this node's parent chain is all expanded
                // Since allNodes is pre-ordered, we track visibility via parent set
                const parentKey = (() => {
                    const acc = budgetableAccounts.find(a => a.guid === node.guid);
                    if (!acc) return 'root';
                    return acc.parent_guid && allGuids.has(acc.parent_guid) ? acc.parent_guid : 'root';
                })();

                if (visibleParents.has(parentKey)) {
                    visible.push(node);
                    if (node.hasChildren && expandedSet.has(node.guid)) {
                        visibleParents.add(node.guid);
                    }
                }
            }
        }

        return { treeNodes: allNodes, visibleNodes: visible };
    }, [rawAccounts, searchTerm, expandedNodes, existingAccountGuids]);

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

    const expandAll = useCallback(() => {
        const allParents = new Set(treeNodes.filter(n => n.hasChildren).map(n => n.guid));
        setExpandedNodes(allParents);
    }, [treeNodes]);

    const handleAddAccount = async (node: AccountTreeNode) => {
        setIsAdding(true);
        setError(null);
        try {
            const response = await fetch(`/api/budgets/${budgetGuid}/accounts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ account_guid: node.guid })
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Failed to add account');
            }

            onAccountAdded({
                guid: node.guid,
                name: node.name,
                account_type: node.account_type,
                full_name: node.fullname,
            });
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to add account');
        } finally {
            setIsAdding(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Add Account to Budget">
            <div className="space-y-4">
                <div>
                    <input
                        type="text"
                        placeholder="Search accounts..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full px-3 py-2 bg-background-tertiary border border-border-hover rounded-md text-foreground placeholder-foreground-muted focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                        autoFocus
                    />
                </div>

                {!searchTerm && (
                    <div className="flex items-center gap-2">
                        <button
                            onClick={expandAll}
                            className="text-xs text-foreground-secondary hover:text-foreground px-2 py-1 rounded hover:bg-surface-hover transition-colors"
                        >
                            Expand All
                        </button>
                        <button
                            onClick={() => setExpandedNodes(new Set())}
                            className="text-xs text-foreground-secondary hover:text-foreground px-2 py-1 rounded hover:bg-surface-hover transition-colors"
                        >
                            Collapse All
                        </button>
                    </div>
                )}

                {error && (
                    <div className="p-3 bg-rose-900/30 text-rose-400 border border-rose-800/50 rounded-md text-sm">
                        {error}
                    </div>
                )}

                <div className="max-h-80 overflow-y-auto border border-border-hover rounded-md">
                    {isLoading ? (
                        <div className="p-4 text-center text-foreground-secondary">Loading accounts...</div>
                    ) : visibleNodes.length === 0 ? (
                        <div className="p-4 text-center text-foreground-secondary">
                            {searchTerm ? 'No matching accounts found' : 'No accounts available'}
                        </div>
                    ) : (
                        <ul className="divide-y divide-border-hover">
                            {visibleNodes.map((node) => (
                                <li key={node.guid}>
                                    <div
                                        className={`flex items-center w-full px-4 py-2 text-left transition-colors ${
                                            node.isBudgeted
                                                ? 'bg-cyan-500/5'
                                                : 'hover:bg-surface-hover/50'
                                        }`}
                                        style={{ paddingLeft: searchTerm ? '16px' : `${16 + node.depth * 20}px` }}
                                    >
                                        {/* Expand/collapse toggle for parent accounts */}
                                        {!searchTerm && node.hasChildren ? (
                                            <button
                                                onClick={() => toggleExpand(node.guid)}
                                                className="p-0.5 mr-2 rounded hover:bg-border-hover transition-colors flex-shrink-0"
                                            >
                                                <svg
                                                    className={`w-4 h-4 text-foreground-muted transition-transform ${expandedNodes.has(node.guid) ? 'rotate-90' : ''}`}
                                                    fill="none"
                                                    stroke="currentColor"
                                                    viewBox="0 0 24 24"
                                                >
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                                </svg>
                                            </button>
                                        ) : !searchTerm ? (
                                            <span className="w-5 mr-2 flex-shrink-0" />
                                        ) : null}

                                        {/* Account info and add button */}
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className={`font-medium truncate ${node.isBudgeted ? 'text-foreground-secondary' : 'text-foreground'}`}>
                                                    {node.name}
                                                </span>
                                                {node.hasChildren && (
                                                    <span className="text-xs text-foreground-muted flex-shrink-0">
                                                        (parent)
                                                    </span>
                                                )}
                                                {node.isBudgeted && (
                                                    <span className="inline-block px-1.5 py-0.5 bg-cyan-500/20 text-cyan-400 rounded text-xs flex-shrink-0">
                                                        budgeted
                                                    </span>
                                                )}
                                            </div>
                                            <div className="text-sm text-foreground-secondary truncate">
                                                {searchTerm && node.fullname !== node.name && (
                                                    <span className="mr-2">{node.fullname}</span>
                                                )}
                                                <span className="inline-block px-2 py-0.5 bg-background-secondary rounded text-xs text-foreground-secondary">
                                                    {node.account_type}
                                                </span>
                                            </div>
                                        </div>

                                        {/* Add button - shown for all non-budgeted accounts */}
                                        {!node.isBudgeted && (
                                            <button
                                                onClick={() => handleAddAccount(node)}
                                                disabled={isAdding}
                                                className="ml-2 p-1.5 text-foreground-secondary hover:text-cyan-400 hover:bg-cyan-500/10 rounded transition-colors disabled:opacity-50 flex-shrink-0"
                                                title="Add to budget"
                                            >
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                                </svg>
                                            </button>
                                        )}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <div className="flex justify-end">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-foreground-secondary hover:bg-surface-hover rounded-md transition-colors"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </Modal>
    );
}
