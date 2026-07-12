// src/app/(main)/tools/ask/types.ts

export interface DrillDownLink {
    label: string;
    href: string;
}

export type QueryRow = Record<string, unknown>;

/** One question/answer exchange in the chat. */
export interface AskExchange {
    id: string;
    question: string;
    answer?: string;
    sql?: string;
    rows?: QueryRow[];
    links?: DrillDownLink[];
    error?: string;
    pending?: boolean;
}
