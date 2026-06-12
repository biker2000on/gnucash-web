#!/bin/sh
set -e

# Schema bootstrap policy:
#   - Empty database (fresh install): `prisma db push` creates the base
#     GnuCash tables and extension tables from schema.prisma.
#   - Existing database: skip prisma entirely. db-init.js owns ongoing
#     schema sync via idempotent DDL; prisma cannot express everything
#     db-init creates (partial unique indexes, generated tsvector columns)
#     and would report data-loss drift on every boot.
# The probe uses the `books` table as the marker for an initialized
# GnuCash schema. Exit codes: 0 = exists, 1 = missing, 2 = cannot connect.
DB_STATE=$(node -e '
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query("select 1 from information_schema.tables where table_name = $1 limit 1", ["books"])
  .then(r => { console.log(r.rowCount ? "exists" : "empty"); process.exit(0); })
  .catch(() => { console.log("unreachable"); process.exit(0); });
' 2>/dev/null || echo "unreachable")

if [ "$DB_STATE" = "empty" ]; then
  echo "Empty database detected - bootstrapping schema with prisma db push"
  # Run the prisma CLI out of the /opt/prisma-cli side-car. NODE_PATH lets
  # prisma.config.ts resolve `dotenv` and `prisma/config` out of the side-car
  # even though we run from /app so the schema and config paths resolve.
  NODE_PATH=/opt/prisma-cli/node_modules node /opt/prisma-cli/node_modules/prisma/build/index.js db push \
    || echo "Warning: prisma db push failed, continuing anyway"
else
  echo "Database state: $DB_STATE - skipping prisma db push (db-init owns schema sync)"
fi

node db-init.js || echo "Warning: db-init failed, continuing anyway"

# Execute the original command
exec "$@"
