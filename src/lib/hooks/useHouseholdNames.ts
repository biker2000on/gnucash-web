'use client';

import { useQuery } from '@tanstack/react-query';

interface EntityMemberLite {
    role: string;
    name: string | null;
}

interface EntityProfileLite {
    members?: EntityMemberLite[];
}

export interface HouseholdNames {
    /** Display name for the 'self' household member, or null when unset. */
    selfName: string | null;
    /** Display name for the 'spouse' household member, or null when unset. */
    spouseName: string | null;
}

function memberName(profile: EntityProfileLite | null | undefined, role: string): string | null {
    const name = profile?.members?.find(m => m.role === role)?.name?.trim();
    return name ? name : null;
}

/**
 * Resolve 'self'/'spouse' owner values to the household member names from the
 * active book's entity profile (GET /api/entity). Names are cosmetic — any
 * fetch failure just falls back to null so callers render the generic
 * 'Self'/'Spouse' labels. A book switch triggers a full page reload (see
 * BookContext.switchBook), so the cache never leaks across books.
 */
export function useHouseholdNames(): HouseholdNames {
    const { data } = useQuery<EntityProfileLite | null>({
        queryKey: ['entity', 'profile'],
        queryFn: async () => {
            const res = await fetch('/api/entity');
            if (!res.ok) return null;
            return res.json() as Promise<EntityProfileLite>;
        },
        staleTime: 1000 * 60 * 5,
    });

    return {
        selfName: memberName(data, 'self'),
        spouseName: memberName(data, 'spouse'),
    };
}
