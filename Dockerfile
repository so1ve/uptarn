FROM --platform=$BUILDPLATFORM node:24-slim AS web
WORKDIR /app
RUN corepack enable
COPY server/package.json server/pnpm-lock.yaml server/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY server/vite.config.ts ./
COPY server/src/shared ./src/shared
COPY server/web ./web
RUN pnpm run build

FROM --platform=$BUILDPLATFORM node:24-slim AS deps
WORKDIR /app
RUN corepack enable
COPY server/package.json server/pnpm-lock.yaml server/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:24-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server/package.json ./
COPY server/migrations ./migrations
COPY server/src ./src
COPY --from=web /app/public ./public
ENV HOST=0.0.0.0 PORT=8787 UPTARN_DB_PATH=/data/uptarn.db
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "src/node.ts"]
