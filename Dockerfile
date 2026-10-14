FROM node:24-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/

FROM base AS build
# Optional CDN base for the kernel WASM (e.g. https://cdn.example.com/); empty = served by the app itself
ARG VITE_ASSETS_BASE=""
ENV VITE_ASSETS_BASE=$VITE_ASSETS_BASE
RUN pnpm install --frozen-lockfile
COPY shared shared
COPY web web
RUN pnpm --filter web build

FROM base
RUN pnpm install --frozen-lockfile --prod --filter server...
COPY shared/src shared/src
COPY server/src server/src
COPY --from=build /app/web/dist web/dist
ENV PORT=8787 HOST=0.0.0.0 DATA_DIR=/data NODE_ENV=production
# Unprivileged node user (uid 1000)
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
WORKDIR /app/server
CMD ["node_modules/.bin/tsx", "src/main.ts"]
