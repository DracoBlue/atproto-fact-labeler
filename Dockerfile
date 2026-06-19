# syntax=docker/dockerfile:1.7
FROM node:26-alpine AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.0.0 --activate
RUN apk add --no-cache python3 make g++
WORKDIR /app
# pnpm-workspace.yaml carries `onlyBuiltDependencies` — without it pnpm 11
# refuses to run better-sqlite3's native build and the install errors out.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM node:26-alpine
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production \
    SQLITE_PATH=/data/labeler.sqlite \
    # CI=true tells pnpm we are non-interactive — required so that one-off
    # ops like `docker compose run --rm fact-labeler pnpm ingest` do not
    # block on the verify-deps-before-run interactive purge prompt.
    CI=true
# pnpm is available in the runtime image for operator one-off ops
# (`pnpm ingest`, `pnpm cli:embed-rebuild`, `pnpm cli:label`,
# `pnpm dlx @skyware/labeler ...`). The service start (CMD below) still
# calls tsx directly to avoid pnpm's deps-status-check on every boot.
#
# We install pnpm via npm rather than corepack: corepack caches the
# downloaded pnpm version in the *invoking user's* `~/.cache/node/corepack`.
# When `corepack prepare` runs as root at build time and then USER switches
# to `node`, the runtime `pnpm` invocation finds the node user's cache
# empty and re-downloads pnpm on every operator command — visible as
# `Corepack is about to download https://registry.npmjs.org/pnpm/...` on
# every `pnpm run X`. Plain npm-install drops the binary under
# `/usr/local/lib/node_modules` which is system-wide readable.
RUN npm install -g pnpm@11.0.0 && npm cache clean --force
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY src ./src
COPY config ./config
# /app must be writable by the runtime user (tsx writes its build cache;
# pnpm writes scratch files for the deps check even with CI=true).
# /data is the persistent volume mount point — chown it so the labeler can
# create the SQLite file and the signing key on first boot.
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME /data
EXPOSE 14831
USER node
# Run tsx directly. Going through `pnpm start` triggers pnpm 11's
# verify-deps-before-run check on every container boot. Calling tsx
# directly skips that and starts the labeler in <1 s.
CMD ["node_modules/.bin/tsx", "src/index.ts"]
