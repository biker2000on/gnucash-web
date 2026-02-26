import { createColumnHelper, ColumnDef } from '@tanstack/react-table';
import { AccountTransaction } from './types';

const columnHelper = createColumnHelper<AccountTransaction>();

export function getColumns(meta: {
    accountGuid: string;
    isReconciling: boolean;
    isReviewMode: boolean;
}): ColumnDef<AccountTransaction, any>[] {
    const columns: ColumnDef<AccountTransaction, any>[] = [];

    // Checkbox column (reconciliation or review mode)
    if (meta.isReconciling || meta.isReviewMode) {
        columns.push(
            columnHelper.display({
                id: 'select',
                header: 'select',
                size: 40,
            })
        );
    }

    // Reconcile state
    columns.push(
        columnHelper.accessor('account_split_reconcile_state', {
            id: 'reconcile',
            header: 'R',
            size: 40,
        })
    );

    // Date
    columns.push(
        columnHelper.accessor('post_date', {
            id: 'date',
            header: 'Date',
        })
    );

    // Description
    columns.push(
        columnHelper.accessor('description', {
            id: 'description',
            header: 'Description',
        })
    );

    // Transfer / Splits
    columns.push(
        columnHelper.display({
            id: 'transfer',
            header: 'Transfer / Splits',
        })
    );

    // Amount
    columns.push(
        columnHelper.accessor('account_split_value', {
            id: 'amount',
            header: 'Amount',
        })
    );

    // Balance
    columns.push(
        columnHelper.accessor('running_balance', {
            id: 'balance',
            header: 'Balance',
        })
    );

    // Edit button (review mode)
    if (meta.isReviewMode) {
        columns.push(
            columnHelper.display({
                id: 'actions',
                header: '',
                size: 40,
            })
        );
    }

    return columns;
}
