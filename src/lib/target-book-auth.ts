import {
  hasMinimumRole,
  roleAtLeast,
  type Role,
} from '@/lib/services/permission.service';

export interface AuthorizedBookContext {
  user: { id: number };
  role: Role;
  bookGuid: string;
  viaToken?: boolean;
}

/**
 * Authorize the requested target rather than trusting the active session
 * book. Bearer tokens remain pinned to the book encoded in the token.
 */
export async function hasTargetBookRole(
  context: AuthorizedBookContext,
  targetBookGuid: string,
  minimumRole: Role,
): Promise<boolean> {
  if (context.viaToken) {
    return context.bookGuid === targetBookGuid
      && roleAtLeast(context.role, minimumRole);
  }
  return hasMinimumRole(context.user.id, targetBookGuid, minimumRole);
}
