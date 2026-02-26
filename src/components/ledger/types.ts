import { AccountTransaction } from '../AccountLedger';

export interface LedgerMeta {
    accountGuid: string;
    accountType: string;
    isReconciling: boolean;
    isReviewMode: boolean;
    focusedRowIndex: number;
    editingGuid: string | null;
    balanceReversal: string;
}

export type { AccountTransaction };
