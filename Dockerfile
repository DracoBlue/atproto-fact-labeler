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
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production \
    SQLITE_PATH=/data/labeler.sqlite \
    # pnpm 11 normally runs `verify-deps-before-run` on every `pnpm run X`
    # call. In a production image node_modules is baked from the deps stage,
    # so the check is both unnecessary and harmful: it writes a tmp probe
    # file to the CWD (`/app/_tmp_*`) which fails with EACCES when /app is
    # owned by root and the process runs as the `node` user. Disable it.
    npm_config_verify_deps_before_run=false
RUN corepack enable && corepack prepare pnpm@11.0.0 --activate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src
# /app must be writable by the runtime user (tsx writes its build cache; pnpm
# also writes scratch files even with the deps check disabled). /data is the
# persistent volume mount point — chown it so the labeler can create the
# SQLite file on first boot.
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME /data
EXPOSE 14831
USER node
CMD ["pnpm", "start"]
