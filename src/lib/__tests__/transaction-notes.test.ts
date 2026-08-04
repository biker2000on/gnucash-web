import { describe, expect, it, vi } from 'vitest';
import { readTransactionNotes, writeTransactionNotes } from '../transaction-notes';

type SlotsClient = Parameters<typeof writeTransactionNotes>[0];

function makeClient(existing: { id: number } | null = null) {
    const slots = {
        findFirst: vi.fn().mockResolvedValue(existing),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    return { client: { slots } as unknown as SlotsClient, slots };
}

const TX_GUID = 'tx00000000000000000000000000001';

describe('writeTransactionNotes', () => {
    it('leaves stored notes untouched when notes is undefined', async () => {
        const { client, slots } = makeClient();
        await writeTransactionNotes(client, TX_GUID, undefined);
        expect(slots.create).not.toHaveBeenCalled();
        expect(slots.update).not.toHaveBeenCalled();
        expect(slots.deleteMany).not.toHaveBeenCalled();
    });

    it('deletes the slot when notes is the empty string', async () => {
        const { client, slots } = makeClient();
        await writeTransactionNotes(client, TX_GUID, '');
        expect(slots.deleteMany).toHaveBeenCalledWith({
            where: { obj_guid: TX_GUID, name: 'notes' },
        });
        expect(slots.create).not.toHaveBeenCalled();
    });

    it('creates a string slot (slot_type 4) when none exists', async () => {
        const { client, slots } = makeClient(null);
        await writeTransactionNotes(client, TX_GUID, 'hello');
        expect(slots.create).toHaveBeenCalledWith({
            data: {
                obj_guid: TX_GUID,
                name: 'notes',
                slot_type: 4,
                string_val: 'hello',
            },
        });
    });

    it('updates the existing slot in place', async () => {
        const { client, slots } = makeClient({ id: 42 });
        await writeTransactionNotes(client, TX_GUID, 'revised');
        expect(slots.update).toHaveBeenCalledWith({
            where: { id: 42 },
            data: { string_val: 'revised', slot_type: 4 },
        });
        expect(slots.create).not.toHaveBeenCalled();
    });
});

describe('readTransactionNotes', () => {
    it('returns an empty map without querying for an empty guid list', async () => {
        const { client, slots } = makeClient();
        const map = await readTransactionNotes(client, []);
        expect(map.size).toBe(0);
        expect(slots.findMany).not.toHaveBeenCalled();
    });

    it('maps guids to note text', async () => {
        const { client, slots } = makeClient();
        slots.findMany.mockResolvedValue([
            { obj_guid: 'a', string_val: 'note a' },
            { obj_guid: 'b', string_val: null },
        ]);
        const map = await readTransactionNotes(client, ['a', 'b']);
        expect(map.get('a')).toBe('note a');
        expect(map.get('b')).toBe('');
    });
});
