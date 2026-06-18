# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.0.0 --activate
RUN apk add --no-cache python3 make g++
WORKDIR /app
# pnpm-workspace.yaml carries `onlyBuiltDependencies` — without it pnpm 11
# refuses to run better-sqlite3's native build and the install errors out.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM node:24-alpine
ENV NODE_ENV=production \
    SQLITE_PATH=/data/labeler.sqlite \
    # CI=true tells pnpm we are non-interactive — needed if any code path
    # (e.g. pnpm dlx for one-off ops like @skyware/labeler setup) ends up
    # running pnpm at runtime.
    CI=true
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Bring the workspace file along so the dep manifest is consistent if pnpm
# is invoked at runtime for one-off ops (`pnpm cli:label`, etc.).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY src ./src
# /app must be writable by the runtime user (tsx writes its build cache).
# /data is the persistent volume mount point — chown it so the labeler can
# create the SQLite file on first boot.
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME /data
EXPOSE 14831
USER node
# Run tsx directly. Going through `pnpm start` triggers pnpm 11's
# verify-deps-before-run check which writes scratch files to /app and (when
# it sees a perceived mismatch) tries to purge node_modules — both fail
# inside a stripped, non-interactive container even after chown + CI=true.
CMD ["node_modules/.bin/tsx", "src/index.ts"]
