# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.0.0 --activate
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM node:24-alpine
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@11.0.0 --activate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src
VOLUME /data
EXPOSE 14831
ENV SQLITE_PATH=/data/labeler.sqlite
USER node
CMD ["pnpm", "start"]
