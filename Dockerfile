# Install ALL dependencies (including dev) for the build stage
FROM node:24-alpine AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ecaf0bd06d133421a#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm config set strict-ssl false && npm install

# Install only production dependencies for the runtime image.
# This is a separate stage so dev deps (playwright, vitest, eslint, tsc, …)
# never land in the final image.
FROM node:24-alpine AS prod-deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json* ./
COPY prisma ./prisma
# Install prod deps, then drop known dead weight:
#   - @next/swc-linux-x64-gnu, @napi-rs/canvas-linux-x64-gnu,
#     lightningcss-linux-x64-gnu — glibc variants unused on Alpine (musl)
#   - playwright(-core) — pulled transitively but never used at runtime
#   - typescript — only a peer dep of @prisma/client, not needed at runtime
# and strip docs/sources from deep node_modules.
# --omit=peer prevents npm from auto-installing peer deps like typescript.
# NOTE: @prisma/studio-core and @prisma/dev must stay — the prisma CLI
# requires them at load time even for `prisma db push`.
RUN npm config set strict-ssl false \
 && npm install --omit=dev --omit=peer \
 && rm -rf \
      node_modules/@next/swc-linux-x64-gnu \
      node_modules/@napi-rs/canvas-linux-x64-gnu \
      node_modules/lightningcss-linux-x64-gnu \
      node_modules/playwright \
      node_modules/playwright-core \
      node_modules/typescript \
 && find node_modules \( -name "*.md" -o -name "*.map" -o -name "CHANGELOG*" -o -name "LICENSE*" -o -name "README*" \) -delete 2>/dev/null || true \
 && find node_modules -type d \( -name "test" -o -name "tests" -o -name "__tests__" -o -name "docs" -o -name "example" -o -name "examples" \) -prune -exec rm -rf {} + 2>/dev/null || true \
 && npm cache clean --force

# Rebuild the source code only when needed
FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client (required before build for TypeScript types)
RUN NODE_TLS_REJECT_UNAUTHORIZED=0 npx prisma generate

RUN npm run build

# Production image, copy all the files and run next
FROM node:24-alpine AS runner
WORKDIR /app

LABEL org.opencontainers.image.source="https://github.com/biker2000on/gnucash-web"
LABEL org.opencontainers.image.description="GnuCash Web - Progressive Web App for viewing GnuCash financial data"
LABEL org.opencontainers.image.licenses="MIT"

ENV NODE_ENV production
# Uncomment the following line in case you want to disable telemetry during runtime.
ENV NEXT_TELEMETRY_DISABLED 1

# Install tesseract-ocr for receipt OCR and poppler-utils for PDF thumbnail rendering
RUN apk add --no-cache tesseract-ocr tesseract-ocr-data-eng poppler-utils

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

# Set the correct permission for prerender cache
RUN mkdir .next
RUN chown nextjs:nodejs .next

RUN mkdir -p data/receipts
RUN chown nextjs:nodejs data/receipts

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Worker support: source files and full node_modules for tsx/bullmq
COPY --from=builder --chown=nextjs:nodejs /app/worker.ts ./
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER nextjs

ENTRYPOINT ["./docker-entrypoint.sh"]

EXPOSE 3000

ENV PORT 3000
# set hostname to localhost
ENV HOSTNAME "0.0.0.0"

# server.js is created by next build from the standalone output
# https://nextjs.org/docs/pages/api-reference/next-config-js/output
CMD ["node", "server.js"]
