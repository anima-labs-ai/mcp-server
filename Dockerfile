# Anima MCP Server — unified image
# Build from the mcp-server/ directory: docker build -t <tag> -f Dockerfile .

# ── Stage 1: Install dependencies ──────────────────────────────────
FROM --platform=linux/amd64 oven/bun:1 AS install
WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

# ── Stage 2: Production runtime ────────────────────────────────────
FROM --platform=linux/amd64 oven/bun:1-slim AS runtime
WORKDIR /app

COPY --from=install /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8080/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Cloud Run sets PORT=8080 automatically; loadConfig() reads PORT and
# auto-enables HTTP mode, so no CLI flags needed.
CMD ["bun", "run", "src/index.ts"]
