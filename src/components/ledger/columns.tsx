import { createColumnHelper, ColumnDef } from '@tanstack/react-table';
import { AccountTransaction } from './types';

const columnHelper = createColumnHelper<AccountTransaction>();

export function getColumns(meta: {
    accountGuid: string;
    isReconciling: boolean;
    isEditMode: boolean;
}): ColumnDef<AccountTransaction>[] {
    return [
        // Checkbox column (reconciliation or edit mode)
        ...(meta.isReconciling || meta.isEditMode ? [
            columnHelper.display({
                id: 'select',
                header: 'select',
                size: 40,
            }),
        ] : []),

        // Reconcile state
        columnHelper.accessor('account_split_reconcile_state', {
            id: 'reconcile',
            header: 'R',
            size: 40,
        }),

        // Date
        columnHelper.accessor('post_date', {
            id: 'date',
            header: 'Date',
        }),

        // Description
        columnHelper.accessor('description', {
            id: 'description',
            header: 'Description',
        }),

        // Transfer / Splits
        columnHelper.display({
            id: 'transfer',
            header: 'Transfer / Splits',
        }),

        // Debit
        columnHelper.accessor('account_split_value', {
            id: 'debit',
            header: 'Debit',
        }),

        // Credit
        columnHelper.display({
            id: 'credit',
            header: 'Credit',
        }),

        // Balance
        columnHelper.accessor('running_balance', {
            id: 'balance',
            header: 'Balance',
        }),

        // Edit button (edit mode)
        ...(meta.isEditMode ? [
            columnHelper.display({
                id: 'actions',
                header: '',
                size: 40,
            }),
        ] : []),
    ] as ColumnDef<AccountTransaction>[];
}
