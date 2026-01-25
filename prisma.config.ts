// Prisma Configuration for GnuCash Web
// Loads DATABASE_URL from .env or .env.local
import * as dotenv from "dotenv";
import { defineConfig } from "prisma/config";
import path from "path";

// Load .env.local first, then .env as fallback
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
