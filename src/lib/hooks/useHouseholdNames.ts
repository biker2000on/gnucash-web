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

/** Household roles that can own a record (business owner/officer are excluded). */
export type HouseholdRole = 'self' | 'spouse' | 'dependent';

export interface HouseholdMember {
    role: HouseholdRole;
    /** Display name, or '' when the roster row has no name recorded. */
    name: string;
}

const HOUSEHOLD_ROLES: HouseholdRole[] = ['self', 'spouse', 'dependent'];

/**
 * The full household roster (self, spouse, and dependents) from the active
 * book's entity profile. Business owner/officer rows are filtered out — they
 * are not household members and must never appear in household pickers.
 * Shares the react-query cache key with useHouseholdNames, so pages using both
 * make a single request.
 */
export function useHouseholdMembers(): HouseholdMember[] {
    const { data } = useQuery<EntityProfileLite | null>({
        queryKey: ['entity', 'profile'],
        queryFn: async () => {
            const res = await fetch('/api/entity');
            if (!res.ok) return null;
            return res.json() as Promise<EntityProfileLite>;
        },
        staleTime: 1000 * 60 * 5,
    });

    return (data?.members ?? [])
        .filter(member => (HOUSEHOLD_ROLES as string[]).includes(member.role))
        .map(member => ({ role: member.role as HouseholdRole, name: member.name?.trim() ?? '' }));
}
