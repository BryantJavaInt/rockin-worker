# syntax=docker/dockerfile:1

# ---- build: full toolchain, compiles TypeScript ----
FROM node:25-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime: only compiled JS + production dependencies, non-root ----
FROM node:25-slim AS runtime
LABEL org.opencontainers.image.title="rockin-worker" \
      org.opencontainers.image.description="Incremental API-to-SQLite sync worker that serves its data to LLM agents over MCP" \
      org.opencontainers.image.authors="Bryant Giorgini" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/BryantJavaInt/rockin-worker"
ENV NODE_ENV=production \
    DB_PATH=/data/data.db \
    LOG_DIR=/data/logs
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data

# Sync:  docker run --rm --env-file .env -v rockin-data:/data rockin-worker sync all
# MCP:   docker run -i --rm -v rockin-data:/data rockin-worker serve   (-i keeps stdin open for stdio)
ENTRYPOINT ["node", "dist/main.js"]
CMD ["help"]
