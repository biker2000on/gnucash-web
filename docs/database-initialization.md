# Database Initialization

This application automatically creates required database views on startup.

## Account Hierarchy View

The `account_hierarchy` view is a custom recursive view that provides:

- **Full account paths**: Each account includes its complete path (e.g., "Assets:Current Assets:Checking")
- **Hierarchy levels**: Accounts are broken down into levels (level1 through level6)
- **Level GUIDs**: Each level's GUID is stored for easy navigation
- **Depth tracking**: The depth of each account in the hierarchy
- **Top-level tracking**: Reference to the top-level parent account

### View Structure

The view includes the following columns:
- `depth`: How deep the account is in the hierarchy (1 = top level)
- `level1` through `level6`: Account names at each level
- `guid1` through `guid6`: Account GUIDs at each level
- `fullname`: Complete colon-separated path (e.g., "Expenses:Travel:Airfare")
- All standard account columns (guid, name, account_type, etc.)
- `top_level_guid`: GUID of the top-level ancestor

### Automatic Creation

The view is automatically created or updated when the application starts via the `initializeDatabase()` function in `src/lib/db-init.ts`.

This ensures that:
1. New deployments work immediately without manual database setup
2. The view definition stays in sync with the application code
3. Updates to the view structure are automatically applied

### Manual Creation

If you need to create the view manually, you can run the SQL in `src/lib/db-init.ts` directly against your PostgreSQL database.

## Adding New Views

To add additional database initialization:

1. Add the DDL to `src/lib/db-init.ts`
2. Call the creation function from `initializeDatabase()`
3. The view will be created automatically on next application start
