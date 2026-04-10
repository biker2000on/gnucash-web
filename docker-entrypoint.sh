#!/bin/sh
set -e

# Ensure Prisma-managed tables exist
npx prisma db push || echo "Warning: prisma db push failed, continuing anyway"

# Execute the original command
exec "$@"
