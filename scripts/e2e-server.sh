#!/usr/bin/env bash
# Starts a throwaway Postgres container and the server for Playwright
set -euo pipefail
PORT=${PORT:-8790}
PG=cad-e2e-pg
docker rm -f "$PG" >/dev/null 2>&1 || true
docker run -d --rm --name "$PG" -e POSTGRES_USER=cad -e POSTGRES_PASSWORD=cad -e POSTGRES_DB=cad -p 127.0.0.1:55432:5432 postgres:18-alpine >/dev/null
trap 'docker rm -f "$PG" >/dev/null 2>&1 || true' EXIT
until docker exec "$PG" pg_isready -U cad -h 127.0.0.1 >/dev/null 2>&1; do sleep 0.5; done
rm -rf server/data/e2e
# One IP opens many sockets during the suite; lift per-IP rate limits
PORT=$PORT HOST=127.0.0.1 DATA_DIR=data/e2e DATABASE_URL=postgres://cad:cad@127.0.0.1:55432/cad \
  WS_PER_MINUTE=10000 MCP_PER_MINUTE=100000 MAX_CONNECTIONS_PER_IP=1000 AUTH_REQUEST_TTL_MS=15000 OAUTH_PER_MINUTE=10000 \
  pnpm --filter server start
