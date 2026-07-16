import prisma from '@/lib/prisma';

/**
 * Book roles. readonly/edit/admin form a linear hierarchy; 'timekeeper' sits
 * OUTSIDE it — a restricted role that can only log time against projects and
 * never satisfies any minimum financial role (not even readonly).
 */
export type Role = 'readonly' | 'edit' | 'admin' | 'timekeeper';

const ROLE_HIERARCHY: Record<string, number> = {
  readonly: 0,
  edit: 1,
  admin: 2,
  // 'timekeeper' is deliberately absent: it must never satisfy a minimum
  // financial role. roleAtLeast() fails closed for any name not listed here.
};

/**
 * Fail-closed hierarchy comparison. Any role name that is not part of the
 * linear hierarchy (unknown names, 'timekeeper', null) is treated as rank -1
 * and an unknown minimum as rank +Infinity, so the check can only pass for
 * known role pairs. Never use a raw `HIERARCHY[a] >= HIERARCHY[b]` compare:
 * `undefined >= n` is false but `undefined < n` is ALSO false, which turns a
 * `<`-style guard into an accidental allow.
 */
export function roleAtLeast(role: string | null | undefined, minimumRole: string): boolean {
  const have = role != null ? (ROLE_HIERARCHY[role] ?? -1) : -1;
  const need = ROLE_HIERARCHY[minimumRole] ?? Infinity;
  return have >= need;
}

/** Roles allowed to WRITE timesheet entries (their own, for timekeepers). */
const TIMESHEET_WRITE_ROLES: ReadonlySet<string> = new Set(['timekeeper', 'edit', 'admin']);

/**
 * Timesheet access check: timekeeper/edit/admin may write; readonly may
 * additionally read. Fails closed for unknown role names.
 */
export function hasTimesheetAccess(role: string | null | undefined, access: 'read' | 'write'): boolean {
  if (!role) return false;
  if (TIMESHEET_WRITE_ROLES.has(role)) return true;
  return access === 'read' && role === 'readonly';
}

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
  return roleAtLeast(userRole, minimumRole);
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
