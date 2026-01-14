# Technology Stack

**Analysis Date:** 2026-01-14

## Languages

**Primary:**
- TypeScript 5.x - All application code (`package.json`)

**Secondary:**
- JavaScript - Configuration files (`eslint.config.mjs`, `postcss.config.mjs`)

## Runtime

**Environment:**
- Node.js 20.x (LTS) - Specified via Volta in `package.json`
- Browser runtime (PWA)

**Package Manager:**
- npm (implied by `package-lock.json`)
- Lockfile: `package-lock.json` present

## Frameworks

**Core:**
- Next.js 16.1.1 - Full-stack React framework (`package.json`)
- React 19.2.3 - UI library (`package.json`)
- React DOM 19.2.3 - React DOM renderer (`package.json`)

**Testing:**
- None configured - No testing framework present

**Build/Dev:**
- TypeScript 5.x - Type checking and compilation (`tsconfig.json`)
- Tailwind CSS 4.x - Utility-first CSS (`@tailwindcss/postcss`)
- PostCSS - CSS processing (`postcss.config.mjs`)
- ESLint 9.x - Linting with Next.js config (`eslint.config.mjs`)

## Key Dependencies

**Critical:**
- `pg` 8.16.3 - PostgreSQL client for database connectivity (`src/lib/db.ts`)
- `next-pwa` 5.6.0 - Progressive Web App functionality
- `swagger-jsdoc` 6.2.8 - API documentation generation (`src/lib/swagger.ts`)
- `swagger-ui-react` 5.31.0 - API documentation UI (`src/app/docs/page.tsx`)

**Infrastructure:**
- `pg` - Direct PostgreSQL queries (no ORM)
- Native `fetch` API - Client-side data fetching

## Configuration

**Environment:**
- `.env.local` for environment variables (gitignored)
- `DATABASE_URL` required - PostgreSQL connection string

**Build:**
- `tsconfig.json` - TypeScript compiler options with `@/*` path alias to `./src/*`
- `next.config.ts` - Next.js configuration (minimal)
- `eslint.config.mjs` - ESLint with Next.js core-web-vitals and TypeScript rules
- `postcss.config.mjs` - PostCSS with Tailwind CSS plugin

## Platform Requirements

**Development:**
- Any platform with Node.js 20.x
- PostgreSQL database with GnuCash schema
- No additional tooling required

**Production:**
- Docker container (multi-stage build in `Dockerfile`)
- Node.js 20 Alpine Linux base image
- Requires `DATABASE_URL` environment variable
- Exposes port 3000

---

*Stack analysis: 2026-01-14*
*Update after major dependency changes*
