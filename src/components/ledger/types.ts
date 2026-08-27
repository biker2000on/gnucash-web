import { AccountTransaction } from '../AccountLedger';

export interface LedgerMeta {
    accountGuid: string;
    accountType: string;
    isEditMode: boolean;
    isInvestmentAccount: boolean;
    focusedRowIndex: number;
    editingGuid: string | null;
    balanceReversal: string;
}

export type { AccountTransaction };
