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
  const permission = await prisma.gnucash_web_book_permissions.findFirst({
    where: { user_id: userId, book_guid: bookGuid },
    include: { role: true },
  });
  return (permission?.role.name as Role) ?? null;
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
  const permissions = await prisma.gnucash_web_book_permissions.findMany({
    where: { user_id: userId },
    include: { role: true },
  });

  if (permissions.length === 0) return [];

  const bookGuids = permissions.map(p => p.book_guid);
  const booksRaw = await prisma.books.findMany({
    where: { guid: { in: bookGuids } },
    orderBy: { name: 'asc' },
  });

  const bookMap = new Map(booksRaw.map(b => [b.guid, b.name ?? 'Unnamed Book']));

  return permissions
    .map(p => ({
      guid: p.book_guid,
      name: bookMap.get(p.book_guid) ?? 'Unnamed Book',
      role: p.role.name as Role,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
  const roleRecord = await prisma.gnucash_web_roles.findFirst({
    where: { name: role },
  });
  if (!roleRecord) {
    throw new Error(`Role "${role}" not found`);
  }

  await prisma.gnucash_web_book_permissions.upsert({
    where: {
      user_id_book_guid: { user_id: userId, book_guid: bookGuid },
    },
    create: {
      user_id: userId,
      book_guid: bookGuid,
      role_id: roleRecord.id,
      granted_by: grantedBy,
      granted_at: new Date(),
    },
    update: {
      role_id: roleRecord.id,
      granted_by: grantedBy,
      granted_at: new Date(),
    },
  });
}

/**
 * Revoke a user's access to a book.
 */
export async function revokeAccess(
  userId: number,
  bookGuid: string
): Promise<void> {
  await prisma.gnucash_web_book_permissions.deleteMany({
    where: { user_id: userId, book_guid: bookGuid },
  });
}

/**
 * Check if a user has any permissions at all (used for first-run detection).
 */
export async function userHasAnyPermissions(userId: number): Promise<boolean> {
  const count = await prisma.gnucash_web_book_permissions.count({
    where: { user_id: userId },
  });
  return count > 0;
}
