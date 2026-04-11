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

# Bundle the worker and the db-init entrypoint with esbuild and drop the
# resulting JS inside .next/standalone so they share the traced node_modules.
# Native packages (@prisma/client, sharp, bcrypt) stay external — they already
# live in standalone's traced node_modules and must not be bundled.
RUN npx esbuild worker.ts \
      --bundle --platform=node --target=node24 --format=cjs \
      --external:@prisma/client --external:sharp --external:bcrypt \
      --outfile=.next/standalone/worker.js \
 && npx esbuild scripts/db-init-entrypoint.ts \
      --bundle --platform=node --target=node24 --format=cjs \
      --external:@prisma/client --external:sharp --external:bcrypt \
      --outfile=.next/standalone/db-init.js

# Minimal stage that installs ONLY the prisma CLI and its direct runtime
# inputs. The CLI is not part of next's traced output, so we ship it as a
# small side-car rather than dragging the whole prod node_modules into the
# runtime image.
FROM node:24-alpine AS prisma-cli
WORKDIR /opt/prisma-cli
RUN npm config set strict-ssl false && \
    echo '{"name":"prisma-cli","version":"0.0.0","private":true,"dependencies":{"prisma":"^7.3.0","dotenv":"^17.2.3","@prisma/adapter-pg":"^7.3.0"}}' > package.json && \
    npm install --omit=peer --omit=optional && \
    rm -rf node_modules/@next/swc-linux-x64-gnu \
           node_modules/lightningcss-linux-x64-gnu \
           node_modules/@napi-rs/canvas-linux-x64-gnu && \
    find node_modules \( -name "*.md" -o -name "*.map" -o -name "CHANGELOG*" -o -name "README*" \) -delete 2>/dev/null || true && \
    find node_modules -type d \( -name "test" -o -name "tests" -o -name "__tests__" -o -name "docs" -o -name "example" -o -name "examples" \) -prune -exec rm -rf {} + 2>/dev/null || true && \
    npm cache clean --force

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

# Next.js standalone output — server.js, worker.js (esbuild), db-init.js
# (esbuild), and a traced ~44 MB node_modules with everything the app and
# the bundled workers need at runtime.
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Prisma schema + config are read by the CLI during `prisma db push` at
# container start, so they need to exist at the paths the config expects.
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./

# Prisma CLI side-car (see prisma-cli stage above). Kept out of /app to
# avoid any risk of clashing with standalone's traced node_modules.
COPY --from=prisma-cli --chown=nextjs:nodejs /opt/prisma-cli /opt/prisma-cli

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
