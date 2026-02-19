import prisma from '@/lib/prisma';

export type Role = 'readonly' | 'edit' | 'admin';

const ROLE_HIERARCHY: Record<Role, number> = {
  readonly: 0,
  edit: 1,
  admin: 2,
};

/**
 * Get a user's role for a specific book.
 */
export async function getUserRoleForBook(
  userId: number,
  bookGuid: string
): Promise<Role | null> {
  const permission = await prisma.$queryRaw<{ name: string }[]>`
    SELECT r.name
    FROM gnucash_web_book_permissions bp
    JOIN gnucash_web_roles r ON r.id = bp.role_id
    WHERE bp.user_id = ${userId} AND bp.book_guid = ${bookGuid}
    LIMIT 1
  `;
  return (permission[0]?.name as Role) ?? null;
}

/**
 * Check if a user has at least the minimum required role for a book.
 */
export async function hasMinimumRole(
  userId: number,
  bookGuid: string,
  minimumRole: Role
): Promise<boolean> {
  const userRole = await getUserRoleForBook(userId, bookGuid);
  if (!userRole) return false;
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[minimumRole];
}

/**
 * Get all books a user has access to, with their role.
 */
export async function getUserBooks(
  userId: number
): Promise<{ guid: string; name: string; role: Role }[]> {
  const rows = await prisma.$queryRaw<{ guid: string; name: string; role: string }[]>`
    SELECT b.guid, COALESCE(b.name, 'Unnamed Book') as name, r.name as role
    FROM gnucash_web_book_permissions bp
    JOIN books b ON b.guid = bp.book_guid
    JOIN gnucash_web_roles r ON r.id = bp.role_id
    WHERE bp.user_id = ${userId}
    ORDER BY b.name
  `;
  return rows.map(r => ({ ...r, role: r.role as Role }));
}

/**
 * Grant a role to a user for a book.
 */
export async function grantRole(
  userId: number,
  bookGuid: string,
  role: Role,
  grantedBy: number
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO gnucash_web_book_permissions (user_id, book_guid, role_id, granted_by, granted_at)
    VALUES (
      ${userId}, ${bookGuid},
      (SELECT id FROM gnucash_web_roles WHERE name = ${role}),
      ${grantedBy}, NOW()
    )
    ON CONFLICT (user_id, book_guid)
    DO UPDATE SET role_id = (SELECT id FROM gnucash_web_roles WHERE name = ${role}),
                  granted_by = ${grantedBy},
                  granted_at = NOW()
  `;
}

/**
 * Revoke a user's access to a book.
 */
export async function revokeAccess(
  userId: number,
  bookGuid: string
): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM gnucash_web_book_permissions
    WHERE user_id = ${userId} AND book_guid = ${bookGuid}
  `;
}

/**
 * Check if a user has any permissions at all (used for first-run detection).
 */
export async function userHasAnyPermissions(userId: number): Promise<boolean> {
  const result = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) as count FROM gnucash_web_book_permissions WHERE user_id = ${userId}
  `;
  return Number(result[0]?.count ?? 0) > 0;
}
