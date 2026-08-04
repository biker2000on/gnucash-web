import type { ExtendedPrismaClient } from '@/lib/prisma';

/** GnuCash KvpValue type tag for a string slot. */
const SLOT_TYPE_STRING = 4;

/** Global client or an interactive-transaction client. */
type SlotClient = Omit<
    ExtendedPrismaClient,
    '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Write a transaction's notes to the GnuCash `slots` table (name='notes'),
 * matching how GnuCash desktop stores them.
 *
 * Semantics follow CreateTransactionRequest.notes: `undefined` leaves the
 * stored notes untouched (callers that don't know about notes cannot clear
 * them), `''` deletes the slot, any other string upserts it.
 */
export async function writeTransactionNotes(
    client: SlotClient,
    txGuid: string,
    notes: string | undefined,
): Promise<void> {
    if (notes === undefined) return;

    if (notes === '') {
        await client.slots.deleteMany({ where: { obj_guid: txGuid, name: 'notes' } });
        return;
    }

    const existing = await client.slots.findFirst({
        where: { obj_guid: txGuid, name: 'notes' },
        select: { id: true },
    });
    if (existing) {
        await client.slots.update({
            where: { id: existing.id },
            data: { string_val: notes, slot_type: SLOT_TYPE_STRING },
        });
    } else {
        await client.slots.create({
            data: {
                obj_guid: txGuid,
                name: 'notes',
                slot_type: SLOT_TYPE_STRING,
                string_val: notes,
            },
        });
    }
}

/** Batch-read notes for a set of transactions. Returns guid -> notes text. */
export async function readTransactionNotes(
    client: SlotClient,
    txGuids: string[],
): Promise<Map<string, string>> {
    if (txGuids.length === 0) return new Map();
    const rows = await client.slots.findMany({
        where: { obj_guid: { in: txGuids }, name: 'notes' },
        select: { obj_guid: true, string_val: true },
    });
    return new Map(rows.map(r => [r.obj_guid, r.string_val ?? '']));
}
